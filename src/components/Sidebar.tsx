import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, type ContinueEntry, type SourceSummary } from "../api";
import { compactNumber, timeAgo } from "./ui";

type Props = {
  sources: SourceSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onOpenRepo: () => void;
  onOpenHistory: () => void;
  onOpenShelf: () => void;
  /** How many lists are saved, shown next to the tab. */
  shelfCount?: number;
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

  // Re-fetch whenever the parent reports that progress moved.
  useEffect(() => {
    let cancelled = false;
    api
      .continueReading()
      .then((list) => {
        if (!cancelled) setReading(list);
      })
      .catch(() => {
        /* the shelf is a convenience; failing to load it must not break the app */
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
      props.onChanged();
    } catch (err) {
      window.alert(errorMessage(err));
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
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="primary"
            style={{ flex: 1 }}
            onClick={props.onOpenRepo}
            disabled={props.busy}
          >
            导入合集
          </button>
          <button
            onClick={() => props.onToggleFilter(!props.filterOnlyFavorites)}
            title="只看收藏"
            style={{ opacity: props.filterOnlyFavorites ? 1 : 0.6 }}
          >
            ★
          </button>
        </div>
      </div>

      <div className="tabs">
        <button className="tab active">源</button>
        <button className="tab" onClick={props.onOpenVerify}>
          校验
        </button>
        <button className="tab" onClick={props.onOpenHistory}>
          历史
        </button>
        <button
          className="tab"
          onClick={props.onOpenShelf}
          title="把常读的分类收进书架，随时回去接着读"
        >
          书架{(props.shelfCount ?? 0) > 0 ? ` ${props.shelfCount}` : ""}
        </button>
        <button className="tab" onClick={props.onOpenSettings}>
          设置
        </button>
      </div>

      <div className="sidebar-body">
        {reading.length > 0 && (
          <div className="continue">
            <div className="continue-head">继续阅读</div>
            {reading.map((entry) => (
              <div
                key={entry.url}
                className="continue-row"
                onClick={() => props.onContinue?.(entry)}
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
              {grouped.length > 1 && <div className="src-group">{group}</div>}
              {list.map((s) => (
                <div
                  key={s.id}
                  className={`src-item${s.id === props.selectedId ? " selected" : ""}${
                    s.enabled ? "" : " disabled"
                  }`}
                  onClick={() => props.onSelect(s.id)}
                  title={`${s.name}\n${s.url}${s.health ? `\n${s.health.status}` : ""}`}
                >
                  <span
                    className={`dot ${
                      s.health ? (s.health.ok ? "ok" : "bad") : "unknown"
                    }`}
                  />
                  <span className="src-name">{s.name || s.url}</span>
                  <button
                    className={`star${s.favorite ? " on" : ""}`}
                    onClick={(e) => toggleFavorite(s, e)}
                    title={s.favorite ? "取消收藏" : "收藏"}
                  >
                    ★
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <button onClick={props.onOpenVerify} disabled={props.sources.length === 0}>
          校验全部
        </button>
        <span className="spacer" />
        {props.stats && props.stats.checked > 0 && (
          <span
            title="已检测源中可用的数量"
            onClick={props.onOpenVerify}
            style={{ cursor: "pointer" }}
          >
            {props.stats.working}/{props.stats.checked} 可用
          </span>
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