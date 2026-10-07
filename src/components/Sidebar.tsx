import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, type ContinueEntry, type SourceSummary } from "../api";
import { KindIcon, compactNumber, timeAgo } from "./ui";
import { useKeyboardRows } from "./keyboardRow";

type Props = {
  sources: SourceSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onOpenRepo: () => void;
  onOpenHistory: () => void;
  onOpenShelf: () => void;
  /** Open the reading statistics panel. */
  onOpenStats: () => void;
  onOpenHighlights: () => void;
  /** How many lists are saved, shown next to the tab. */
  shelfCount?: number;
  /** How many passages are highlighted, shown next to the tab. */
  highlightCount?: number;
  onOpenVerify: () => void;
  onOpenSettings: () => void;
  stats: { sources: number; working: number; checked: number } | null;
  filterOnlyFavorites: boolean;
  onToggleFilter: (v: boolean) => void;
  busy: boolean;
  /** Open a half-read article from the 继续阅读 shelf. */
  onContinue?: (entry: ContinueEntry) => void;
  /** Bumped by the parent whenever reading progress changes. */
  progressToken?: number;
};

export function Sidebar(props: Props) {
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<ContinueEntry[]>([]);
  /** Set when the 继续阅读 shelf could not be read; see below. */
  const [continueFailed, setContinueFailed] = useState(false);
  /**
   * The last favorite toggle that failed, with its source still attached.
   *
   * A bare `window.alert` used to be the whole story here: the error was shown
   * and the reader had no next step. Keeping the source is what makes a retry
   * possible — 重试 repeats exactly this toggle, not some other request.
   */
  const [favFailed, setFavFailed] = useState<{ source: SourceSummary; message: string } | null>(
    null,
  );
  const rows = useKeyboardRows();

  // Re-fetch whenever the parent reports that progress moved.
  useEffect(() => {
    let cancelled = false;
    api
      .continueReading()
      .then((list) => {
        if (cancelled) return;
        setReading(list);
        setContinueFailed(false);
      })
      .catch(() => {
        /* Degrading quietly is right — the shelf is a convenience, not the app.
           Staying silent is not: with no shelf and no explanation, the reader
           concludes their progress is gone. So the shelf disappears and a quiet
           line says why; the progress itself is untouched. */
        if (!cancelled) setContinueFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [props.progressToken]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.sources.filter((s) => {
      if (props.filterOnlyFavorites && !s.favorite) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.url.toLowerCase().includes(q) ||
        s.group.toLowerCase().includes(q) ||
        s.collection.toLowerCase().includes(q)
      );
    });
  }, [props.sources, query, props.filterOnlyFavorites]);

  const grouped = useMemo(() => {
    const map = new Map<string, SourceSummary[]>();
    for (const s of visible) {
      const key = s.collection || "其他";
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return Array.from(map.entries());
  }, [visible]);

  async function toggleFavorite(s: SourceSummary, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.updateSource(s.id, { favorite: !s.favorite });
      setFavFailed(null);
      props.onChanged();
    } catch (err) {
      // Inline, with a way forward: the same toggle can be re-issued from the
      // notice below, instead of the error being a dead end in a system box.
      setFavFailed({ source: s, message: errorMessage(err) });
    }
  }

  /** Re-issue the favorite toggle that just failed. */
  async function retryFavorite() {
    const failed = favFailed;
    if (!failed) return;
    try {
      await api.updateSource(failed.source.id, { favorite: !failed.source.favorite });
      setFavFailed(null);
      props.onChanged();
    } catch (err) {
      setFavFailed({ source: failed.source, message: errorMessage(err) });
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <div className="brand-mark" />
          Serious
          <small>{props.stats ? `${props.stats.sources} 源` : ""}</small>
        </div>
        <input
          placeholder="搜索源名称或地址…"
          aria-label="搜索源"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sidebar-actions">
          <button
            className="primary"
            onClick={props.onOpenRepo}
            disabled={props.busy}
          >
            导入合集
          </button>
          <button
            className={props.filterOnlyFavorites ? "on" : ""}
            data-sidebar-filter="favorites"
            onClick={() => props.onToggleFilter(!props.filterOnlyFavorites)}
            title="只看收藏"
            aria-pressed={props.filterOnlyFavorites}
          >
            {props.filterOnlyFavorites ? "★ 只看收藏" : "☆ 只看收藏"}
          </button>
        </div>
      </div>

      {/*
        Seven destinations in 300px: a single flex row wraps them into
        single-character columns. The grid below flows them into icon+label
        tiles that never wrap mid-tile (no more 竖叠), with the source list
        itself as the active tile. Keyboard rows and aria-current are kept —
        only the layout changes, not the navigation contract.
      */}
      <nav className="tabs" aria-label="主要导航">
        <button className="tab active" aria-current="page">
          <KindIcon kind="novel" />
          <span>源</span>
        </button>
        <button className="tab" onClick={props.onOpenVerify}>
          <KindIcon kind="verify" />
          <span>校验</span>
        </button>
        <button className="tab" onClick={props.onOpenHistory}>
          <KindIcon kind="history" />
          <span>历史</span>
        </button>
        <button
          className="tab"
          onClick={props.onOpenShelf}
          title="把常读的分类收进书架，随时回去接着读"
        >
          <KindIcon kind="shelf" />
          <span>书架{(props.shelfCount ?? 0) > 0 ? ` ${props.shelfCount}` : ""}</span>
        </button>
        <button
          className="tab"
          onClick={props.onOpenStats}
          title="今天、本周读了多少"
        >
          <KindIcon kind="stats" />
          <span>统计</span>
        </button>
        <button
          className="tab"
          onClick={props.onOpenHighlights}
          title="所有划线与笔记"
        >
          <KindIcon kind="marks" />
          <span>划线{(props.highlightCount ?? 0) > 0 ? ` ${props.highlightCount}` : ""}</span>
        </button>
        <button className="tab" onClick={props.onOpenSettings}>
          <KindIcon kind="settings" />
          <span>设置</span>
        </button>
      </nav>

      <div className="sidebar-body">
        {favFailed && (
          <div
            data-fav-error
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              fontSize: 12,
              lineHeight: 1.7,
              color: "var(--err)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              marginBottom: 6,
            }}
          >
            <span style={{ flex: 1 }}>收藏失败：{favFailed.message}</span>
            <button className="primary" data-fav-retry onClick={() => void retryFavorite()}>
              重试
            </button>
            <button className="ghost" aria-label="关闭" onClick={() => setFavFailed(null)}>
              ✕
            </button>
          </div>
        )}
        {continueFailed && (
          // Inline rather than in the shared stylesheet: this round is not
          // allowed to touch styles.css, and a stylesheet rule that never loads
          // is worse than one long line here.
          <div
            className="continue-note"
            data-sidebar-note="continue-failed"
            style={{
              color: "var(--text-faint)",
              fontSize: 12,
              lineHeight: 1.7,
              padding: "6px 8px 2px",
            }}
          >
            继续阅读暂时读不出来（多半是源又在抽风），阅读进度没有丢，进度在「历史」里。
          </div>
        )}
        {reading.length > 0 && (
          <div className="continue">
            <div className="continue-head">继续阅读</div>
            {reading.map((entry) => (
              <div
                key={entry.url}
                className="continue-row"
                onClick={() => props.onContinue?.(entry)}
                {...rows.propsFor(`continue:${entry.url}`, () => props.onContinue?.(entry), {
                  label: `继续阅读 ${entry.title || entry.url}，已读 ${Math.round(entry.progress * 100)}%`,
                })}
                title={`${entry.title}\n${entry.source_name}`}
              >
                <div className="continue-title">{entry.title || entry.url}</div>
                <div className="continue-meta">
                  {entry.source_name} · {timeAgo(entry.viewed_at)} · 已读{" "}
                  {Math.round(entry.progress * 100)}%
                </div>
                <div className="continue-bar">
                  <div style={{ width: `${Math.round(entry.progress * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {visible.length === 0 ? (
          <div style={{ color: "var(--text-faint)", padding: 16, fontSize: 13, lineHeight: 1.8 }}>
            {props.sources.length === 0
              ? "还没有源。点击「导入合集」，从源仓库挑选共享的订阅源合集。"
              : "没有匹配的源。"}
          </div>
        ) : (
          grouped.map(([group, list]) => (
            <div key={group}>
              {grouped.length > 1 && (
                <div className="src-group">
                  {group} · {list.length} 个源
                </div>
              )}
              {list.map((s) => (
                <div
                  key={s.id}
                  className={`src-item${s.id === props.selectedId ? " selected" : ""}${
                    s.enabled ? "" : " disabled"
                  }`}
                  onClick={() => props.onSelect(s.id)}
                  // The main navigation of the app: without a tab stop and a
                  // role, a keyboard user cannot change source at all.
                  {...rows.propsFor(`src:${s.id}`, () => props.onSelect(s.id), {
                    label: `${s.name || s.url}${s.enabled ? "" : "（已停用）"}`,
                  })}
                  aria-current={s.id === props.selectedId ? "true" : undefined}
                  title={`${s.name}\n${s.url}${s.health ? `\n${s.health.status}` : ""}`}
                >
                  <span
                    className={`dot ${
                      s.health ? (s.health.ok ? "ok" : "bad") : "unknown"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="src-main">
                    <span className="src-name">{s.name || s.url}</span>
                    {s.health && (
                      <span className="src-sub">{timeAgo(s.health.checked_at)}</span>
                    )}
                  </span>
                  <button
                    className={`star${s.favorite ? " on" : ""}`}
                    onClick={(e) => toggleFavorite(s, e)}
                    title={s.favorite ? "取消收藏" : "收藏"}
                    aria-label={s.favorite ? `取消收藏 ${s.name || s.url}` : `收藏 ${s.name || s.url}`}
                    aria-pressed={s.favorite}
                  >
                    <span aria-hidden="true">{s.favorite ? "★" : "☆"}</span>
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot" role="status" aria-label="源状态">
        <button
          onClick={props.onOpenVerify}
          disabled={props.sources.length === 0}
          data-sidebar-action="verify-all"
        >
          {props.busy ? "校验中…" : "校验全部"}
        </button>
        <span className="spacer" />
        {props.stats && props.stats.checked > 0 && (
          // Icon + text + colour: the ratio never speaks through colour alone.
          // The pill stays a keyboard row (not a bare span) so it can be
          // opened from the keyboard, as before.
          <button
            className={`avail-pill avail-${props.stats.working === props.stats.checked ? "ok" : props.stats.working === 0 ? "bad" : "warn"}`}
            {...rows.propsFor("foot:available", () => props.onOpenVerify(), {
              label: `已检测源中 ${props.stats?.working} / ${props.stats?.checked} 可用，打开校验详情`,
            })}
            title="已检测源中可用的数量"
            data-sidebar-action="available"
          >
            <span className="avail-dot" aria-hidden="true" />
            <span aria-live="polite">
              {props.stats.working}/{props.stats.checked} 可用
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}

export function sourceMeta(s: SourceSummary): string {
  const bits: string[] = [];
  if (s.category_count > 1) bits.push(`${compactNumber(s.category_count)} 个分类`);
  if (s.js_enabled) bits.push("含 JS 规则");
  if (s.health) bits.push(timeAgo(s.health.checked_at));
  return bits.join(" · ");
}