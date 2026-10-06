import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Collection, type Settings } from "../api";
import { UpdateSettings } from "./Update";
import { Banner, Spinner, compactNumber } from "./ui";

/**
 * Bounds for 每页条数.
 *
 * These match the backend's own clamp in `validate_settings`
 * (`page_size.clamp(10, 300)`), and they have to: a UI that accepted more than
 * the backend keeps would let a person type 400, watch the save succeed, and
 * then find the list still paging at 300 — a change nobody told them about.
 * Refusing what the app cannot honour is the panel's job, and the real range is
 * exactly what the app honours.
 */
const PAGE_MIN = 10;
const PAGE_MAX = 300;

/** How long a "已保存" confirmation stays on screen. */
const SAVED_NOTE_MS = 2500;

export function SettingsPanel({
  onSourcesChanged,
  onStatsChanged,
  onClose,
}: {
  onSourcesChanged: () => void;
  onStatsChanged: () => void;
  /** Leave settings and go back to whatever was on screen before it. */
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [dataDir, setDataDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The operation that failed, so 重试 repeats that one. See RepoBrowser. */
  const [retry, setRetry] = useState<(() => void) | null>(null);
  /** What is really stored. The screen can be ahead of it while typing, and a
   *  failed save has to be rolled back to *this*, not to whatever was on screen. */
  const stored = useRef<Settings | null>(null);
  /** The number field's own text, so it can be emptied and retyped. */
  const [pageDraft, setPageDraft] = useState("");
  /** Why a field was refused, next to the field rather than in a banner. */
  const [fieldError, setFieldError] = useState<{ field: string; text: string } | null>(null);

  const load = useCallback(() => {
    api
      .getSettings()
      .then((loaded) => {
        // The loaded value is what a failed save has to roll back to, so it is
        // recorded here — never mirrored from `settings`, which is updated
        // optimistically as the user types and would make the rollback a no-op.
        stored.current = loaded;
        setSettings(loaded);
        setPageDraft(String(loaded.page_size));
      })
      .catch((e) => {
        setError(errorMessage(e));
        setRetry(() => () => void load());
      });
    api.listCollections().then(setCollections).catch((e) => {
      setError(errorMessage(e));
      setRetry(() => () => void load());
    });
    api.dataDir().then(setDataDir).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A confirmation that never goes away is a second permanent notice.
  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), SAVED_NOTE_MS);
    return () => window.clearTimeout(id);
  }, [note]);

  /**
   * Write, and make the screen agree with what was written.
   *
   * The order matters: the screen used to be updated first and never corrected,
   * so a failed save left the user looking at a setting that was not stored and
   * vanished on the next launch. Now a failure puts the stored value back and
   * says so.
   */
  async function save(next: Settings, label = "设置") {
    const previous = stored.current;
    setSettings(next);
    try {
      await api.setSettings(next);
      stored.current = next;
      setNote(`已保存${label}`);
    } catch (e) {
      // Roll the screen back to what is really stored — if that is not known
      // yet, re-read it rather than leave the failed value on screen.
      if (previous) setSettings(previous);
      if (previous) setPageDraft(String(previous.page_size));
      setError(`保存失败，已恢复原值：${errorMessage(e)}`);
      setRetry(() => () => void save(next, label));
    }
  }

  /** Validate the number field without substituting a value the user never typed. */
  function commitPageSize(current: Settings) {
    const raw = pageDraft.trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || !Number.isInteger(value)) {
      setFieldError({
        field: "page_size",
        text: `「每页条数」需要是一个整数，现在是「${raw || "空"}」，已经恢复成原来的 ${current.page_size}。`,
      });
      setPageDraft(String(current.page_size));
      return;
    }
    if (value < PAGE_MIN || value > PAGE_MAX) {
      setFieldError({
        field: "page_size",
        text: `每页条数要在 ${PAGE_MIN} 到 ${PAGE_MAX} 之间，现在填的是 ${value}，没有保存，已经恢复成原来的 ${current.page_size}。`,
      });
      setPageDraft(String(current.page_size));
      return;
    }
    setFieldError(null);
    if (value === current.page_size) return;
    void save({ ...current, page_size: value }, `每页条数 ${value}`);
  }

  async function removeAll() {
    const sources = await api.listSources();
    if (sources.length === 0) return;
    if (
      !window.confirm(`确定要删除全部 ${sources.length} 个源吗？此操作不可撤销。`)
    ) {
      return;
    }
    try {
      await api.removeSources(sources.map((s) => s.id));
      onSourcesChanged();
      onStatsChanged();
      setNote("已删除全部源");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!settings) {
    return (
      <div className="main-body">
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="main-head">
        {/*
          Every other panel — history, bookshelf, statistics, highlights, verify —
          offers a way back in its header, and settings is no different: it
          covers the whole reading area, so without this the reader has to know
          that Escape works, or work out that the sidebar entry is a toggle. The
          empty state further down already offers one, but someone who opened
          settings with a list behind them never sees that far.
        */}
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">设置</div>
      </div>
      <div className="main-body">
        <div className="reader">
          {error && (
            <div data-settings-error="1">
              <Banner
                text={error}
                action={
                  retry ? (
                    <button
                      className="primary"
                      data-retry="settings"
                      aria-label="重试"
                      onClick={() => {
                        const again = retry;
                        setRetry(null);
                        setError(null);
                        again();
                      }}
                    >
                      重试
                    </button>
                  ) : undefined
                }
                onClose={() => {
                  setError(null);
                  setRetry(null);
                }}
              />
            </div>
          )}
          {/* A success note is not a failure and has nothing to retry. It fades
              by itself so the page does not collect permanent confirmations. */}
          {note && (
            <div data-settings-note="1">
              <Banner text={note} onClose={() => setNote(null)} />
            </div>
          )}

          <div className="field">
            <label>源仓库地址</label>
            <input
              data-settings-field="repo_base"
              value={settings.repo_base}
              onChange={(e) => setSettings({ ...settings, repo_base: e.target.value })}
              onBlur={() => {
                // Only when it actually changed: saving on every blur would turn
                // a click into a write and, with a broken disk, into an error.
                if (settings.repo_base === stored.current?.repo_base) return;
                void save({ ...settings, repo_base: settings.repo_base }, "仓库地址");
              }}
            />
          </div>

          <div className="field">
            <label>每页条数</label>
            <input
              type="number"
              data-settings-field="page_size"
              min={PAGE_MIN}
              max={PAGE_MAX}
              value={pageDraft}
              onChange={(e) => setPageDraft(e.target.value)}
              onBlur={() => commitPageSize(settings)}
            />
            {fieldError?.field === "page_size" && (
              <p data-settings-field-error="page_size" style={{ color: "var(--warn)", fontSize: 12, marginTop: 4 }}>
                {fieldError.text}
              </p>
            )}
          </div>

          <div className="field">
            <label>
              <input
                type="checkbox"
                style={{ width: "auto", marginRight: 8 }}
                checked={settings.concurrent_checks}
                onChange={(e) => void save({ ...settings, concurrent_checks: e.target.checked }, "并发检测")}
              />
              批量检测时并发请求
            </label>
          </div>

          <div className="field">
            <label title="源声明需要 JavaScript 而页面没解析出内容时，用离屏浏览器渲染一次再解析">
              <input
                type="checkbox"
                style={{ width: "auto", marginRight: 8 }}
                checked={settings.render_js}
                onChange={(e) => void save({ ...settings, render_js: e.target.checked }, "渲染开关")}
              />
              用浏览器渲染脚本页面
            </label>
            <p style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
              少数站点的内容由脚本生成。打开后，只有「这一页解析不出任何条目」时才会多花约 2 秒做一次离屏渲染；
              在 16 个够不着的真实源上实测救回 2 个，因此默认关闭。
            </p>
          </div>

          <h3 style={{ fontSize: 15, margin: "26px 0 10px" }}>已导入的合集</h3>
          {collections.length === 0 ? (
            <p style={{ color: "var(--text-faint)", fontSize: 13 }}>还没有导入任何合集。</p>
          ) : (
            collections.map((c) => (
              <div
                key={c.url}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div>{c.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                    {compactNumber(c.count)} 个源
                    {c.author ? ` · ${c.author}` : ""}
                  </div>
                </div>
                <button
                  className="ghost"
                  onClick={async () => {
                    try {
                      await api.removeCollection(c.url);
                      setCollections(await api.listCollections());
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  从记录移除
                </button>
              </div>
            ))
          )}

          <h3 style={{ fontSize: 15, margin: "26px 0 10px" }}>应用更新</h3>
          <UpdateSettings />

          <h3 style={{ fontSize: 15, margin: "26px 0 10px" }}>数据</h3>
          {dataDir && (
            <p style={{ fontSize: 12, color: "var(--text-faint)", wordBreak: "break-all" }}>
              数据目录：{dataDir}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={removeAll}>删除全部源</button>
            <button
              onClick={async () => {
                const n = await api.clearCache();
                setNote(n > 0 ? `已清理 ${n} 条缓存` : "缓存本来就是空的");
              }}
            >
              清理内容缓存
            </button>
            <button
              onClick={async () => {
                await api.clearCookies();
                setNote("已清除 Cookie 与脚本缓存");
              }}
            >
              清除 Cookie
            </button>
          </div>
        </div>
      </div>
    </>
  );
}