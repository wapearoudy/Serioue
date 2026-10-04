import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorMessage,
  events,
  type CheckScope,
  type Health,
  type SourceSummary,
  type StageResult,
} from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";

type Row = { id: string; name: string; url: string; health: Health | null };

type Props = {
  sources: SourceSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  onChecked: () => void;
};

const SCOPES: { key: CheckScope; label: string; hint: string }[] = [
  { key: "all", label: "全部", hint: "重新校验所有源" },
  { key: "failed", label: "仅异常", hint: "只重检上次没通过或带警告的源" },
  { key: "unchecked", label: "未检测", hint: "只校验从未检测过的源" },
  { key: "stale", label: "过期", hint: "重试失败项与 3 天前检测过的源" },
];

/** Stage order in the report; unknown keys sort last. */
const STAGE_ORDER = ["rule", "homepage", "list", "detail", "search"];

function stageRank(key: string): number {
  const i = STAGE_ORDER.indexOf(key);
  return i === -1 ? STAGE_ORDER.length : i;
}

function overall(health: Health | null): "ok" | "warn" | "fail" | "none" {
  if (!health) return "none";
  if (health.stages?.some((s) => s.state === "fail")) return "fail";
  if (health.ok) return "ok";
  return "warn";
}

function stateGlyph(state: StageResult["state"]): string {
  switch (state) {
    case "ok":
      return "✓";
    case "warn":
      return "!";
    case "fail":
      return "✕";
    default:
      return "–";
  }
}

/** The overall state, which adds an "unchecked" case the stages never have. */
function overallGlyph(state: ReturnType<typeof overall>): string {
  return state === "none" ? "·" : stateGlyph(state);
}

function duration(ms: number): string {
  if (!ms) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function VerifyPanel({ sources, selectedId, onSelect, onBack, onChecked }: Props) {
  const [rows, setRows] = useState<Row[]>(() => sources.map(toRow));
  const [expanded, setExpanded] = useState<string | null>(selectedId);
  const [scope, setScope] = useState<CheckScope>("all");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const byId = useMemo(() => {
    const map = new Map<string, SourceSummary>();
    for (const s of sources) map.set(s.id, s);
    return map;
  }, [sources]);

  // Results arrive over an event; merge them into the table as they land.
  const merge = useCallback((id: string, name: string, health: Health) => {
    setRows((prev) => {
      const at = prev.findIndex((r) => r.id === id);
      const url = byId.get(id)?.url ?? prev[at]?.url ?? "";
      const row = { id, name, url, health };
      if (at === -1) return [...prev, row];
      const next = prev.slice();
      next[at] = row;
      return next;
    });
  }, [byId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    events
      .onCheckProgress((e) => {
        merge(e.source_id, e.name, e.health);
        setProgress({ done: e.done, total: e.total });
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [merge]);

  // Refresh from the store when a batch finishes, so the sidebar dots match.
  useEffect(() => {
    if (running) return;
    const fresh = sources.filter((s) => s.health).map(toRow);
    if (fresh.length === 0) return;
    setRows((prev) => {
      const checked = new Map(fresh.map((r) => [r.id, r]));
      const next = prev.map((r) => checked.get(r.id) ?? r);
      for (const r of fresh) if (!next.some((n) => n.id === r.id)) next.push(r);
      return next;
    });
  }, [sources, running]);

  const counts = useMemo(() => {
    let ok = 0;
    let warn = 0;
    let fail = 0;
    for (const r of rows) {
      const o = overall(r.health);
      if (o === "ok") ok += 1;
      else if (o === "warn") warn += 1;
      else if (o === "fail") fail += 1;
    }
    return { ok, warn, fail, checked: ok + warn + fail };
  }, [rows]);

  const visible = useMemo(() => {
    const list = onlyProblems ? rows.filter((r) => {
      const o = overall(r.health);
      return o === "fail" || o === "warn" || o === "none";
    }) : rows;
    // Problems first, then unchecked, then healthy — the ones needing action
    // should not require scrolling.
    const rank = (r: Row) => {
      const o = overall(r.health);
      return o === "fail" ? 0 : o === "warn" ? 1 : o === "none" ? 2 : 3;
    };
    return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [rows, onlyProblems]);

  const runRef = useRef(false);
  async function run() {
    if (runRef.current) return;
    runRef.current = true;
    setRunning(true);
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      await api.checkAll({ scope });
      onChecked();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
      setProgress(null);
      runRef.current = false;
    }
  }

  async function cancel() {
    try {
      await api.cancelCheck();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function verifyOne(id: string) {
    setError(null);
    const source = byId.get(id);
    try {
      const health = await api.checkSource(id);
      merge(id, source?.name ?? id, health);
      onChecked();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function copyReport() {
    const lines = visible.map((r) => {
      const head = `## ${r.name}\n${r.url}`;
      if (!r.health) return `${head}\n未检测`;
      const stages = r.health.stages
        ?.map((s) => `- ${stateGlyph(s.state)} ${s.label}: ${s.detail} (${duration(s.ms)})`)
        .join("\n") ?? "";
      return `${head}\n${overallGlyph(overall(r.health))} ${r.health.status}\n${stages}`;
    });
    const text = [`# 源校验报告`, `生成时间: ${new Date().toLocaleString("zh-CN")}`, ``, ...lines].join(
      "\n\n",
    );
    try {
      await navigator.clipboard.writeText(text);
      setError(null);
    } catch (e) {
      setError(`复制失败: ${errorMessage(e)}`);
    }
  }

  const pct =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onBack}>
          ← 返回
        </button>
        <div className="main-title">
          源校验
          <span>
            {counts.checked} / {rows.length} 已检测
            {counts.fail > 0 && ` · ${counts.fail} 个失效`}
            {counts.warn > 0 && ` · ${counts.warn} 个有警告`}
          </span>
        </div>
        <span className="spacer" />
        <button onClick={copyReport} disabled={visible.length === 0} title="复制为 Markdown，便于反馈问题">
          复制报告
        </button>
        {running ? (
          <button onClick={cancel}>停止</button>
        ) : (
          <button className="primary" onClick={run}>
            开始校验
          </button>
        )}
      </div>

      <div className="verify-bar">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            className={scope === s.key ? "tab active" : "tab"}
            title={s.hint}
            disabled={running}
            onClick={() => setScope(s.key)}
          >
            {s.label}
          </button>
        ))}
        <span className="spacer" />
        <label className="verify-toggle">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
          />
          只看有问题的
        </label>
      </div>

      {progress && progress.total > 0 && (
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="main-body">
        {error && <Banner text={error} onClose={() => setError(null)} />}

        {running && rows.length === 0 ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <Empty
            title={onlyProblems ? "没有有问题的源" : "还没有可校验的源"}
            hint={
              onlyProblems
                ? "当前所有源都通过了校验。"
                : "先从源仓库导入合集，再回到这里逐个校验。"
            }
          />
        ) : (
          <div className="verify-list">
            {visible.map((r) => {
              const state = overall(r.health);
              const open = expanded === r.id;
              return (
                <div
                  key={r.id}
                  className={`verify-row${open ? " open" : ""}`}
                  onClick={() => setExpanded(open ? null : r.id)}
                >
                  <div className="verify-line">
                    <span className={`verify-dot ${state}`} />
                    <span className="verify-name">{r.name || r.url}</span>
                    <span className="verify-stages">
                      {(r.health?.stages ?? []).map((s) => (
                        <span key={s.key} className={`chip ${s.state}`} title={`${s.label}：${s.detail}`}>
                          {s.label}
                        </span>
                      ))}
                    </span>
                    <span className="spacer" />
                    <span className="verify-meta">
                      {r.health?.item_count ? `${r.health.item_count} 条` : ""}
                      {r.health ? ` · ${duration(r.health.duration_ms)}` : ""}
                      {r.health ? ` · ${timeAgo(r.health.checked_at)}` : ""}
                    </span>
                  </div>

                  {open && (
                    <div className="verify-detail" onClick={(e) => e.stopPropagation()}>
                      <div className="verify-url">{r.url}</div>
                      {r.health ? (
                        <table className="verify-table">
                          <tbody>
                            {(r.health.stages ?? [])
                              .slice()
                              .sort((a, b) => stageRank(a.key) - stageRank(b.key))
                              .map((s) => (
                                <tr key={s.key} className={s.state}>
                                  <td className="st">{stateGlyph(s.state)}</td>
                                  <td className="lb">{s.label}</td>
                                  <td>{s.detail}</td>
                                  <td className="ms">{duration(s.ms)}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      ) : (
                        <p className="verify-none">这个源还没有检测过。</p>
                      )}
                      <div className="verify-actions">
                        <button onClick={() => verifyOne(r.id)}>只校验这个</button>
                        <button
                          className="ghost"
                          onClick={() => onSelect(r.id)}
                          title="打开这个源的列表"
                        >
                          打开源
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function toRow(s: SourceSummary): Row {
  return { id: s.id, name: s.name || s.url, url: s.url, health: s.health };
}