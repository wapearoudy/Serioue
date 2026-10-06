import { useEffect, useState } from "react";
import { api, errorMessage, type HistoryEntry } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";
import { useKeyboardRows } from "./keyboardRow";

/** Records per page of history. The backend keeps 500; the panel pages
 * through them instead of hard-capping at the first screen. */
export const HISTORY_PAGE = 100;
const PAGE = HISTORY_PAGE;

export function HistoryPanel({
  onOpen,
  onClose,
}: {
  onOpen: (entry: HistoryEntry) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** How many records are currently shown. The backend keeps 500, so the
   * panel pages through them instead of hard-capping at the first screen. */
  const [limit, setLimit] = useState(PAGE);
  /** Title filter typed in the panel; applied to everything already loaded. */
  const [query, setQuery] = useState("");
  const rows = useKeyboardRows();

  const load = (nextLimit: number = PAGE) => {
    setItems(null);
    setError(null);
    setLimit(nextLimit);
    api
      .listHistory(nextLimit)
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(() => {
    setItems(null);
    setError(null);
    api
      .listHistory(PAGE)
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Everything loaded so far, narrowed by the title filter. */
  const visible = (items ?? []).filter(
    (h) =>
      query.trim() === "" ||
      (h.title || h.url).toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">阅读历史</div>
        <span className="spacer" />
        <input
          data-history-field="search"
          aria-label="搜索阅读历史"
          placeholder="搜索标题…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <button
          onClick={async () => {
            // Clearing the history deletes the list of what has been read, and
            // nothing can bring it back. Deleting every source already asks for
            // confirmation here; this is the same kind of button and deserves
            // the same question — say how much and say that it is final.
            const count = items?.length ?? 0;
            if (
              !window.confirm(
                `确定要清空阅读历史吗？\n\n会删除全部 ${count} 条阅读记录。这只是本地清空，无法恢复。`,
              )
            ) {
              return;
            }
            try {
              await api.clearHistory();
              setQuery("");
              load();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
          disabled={!items?.length}
        >
          清空
        </button>
      </div>

      <div className="main-body">
        {error && (
          // Reading the history is one local read that can fail on its own, so
          // repeating it is a real option rather than a decoration.
          <Banner
            text={error}
            action={
              <button
                className="primary"
                data-retry="history"
                aria-label="重试加载阅读历史"
                onClick={() => load(limit)}
              >
                重试
              </button>
            }
            onClose={() => setError(null)}
          />
        )}
        {items === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="还没有阅读记录" hint="打开任意一篇文章后会出现在这里。" />
        ) : (
          <>
            <div
              data-history-count="1"
              style={{ fontSize: 12, color: "var(--text-faint)", padding: "8px 18px 0" }}
            >
              {query.trim() === ""
                ? `已加载 ${items.length} 条`
                : `已加载 ${items.length} 条 · 搜到 ${visible.length} 条`}
            </div>
            <div className="list">
              {visible.map((h) => (
                <div
                  className="row"
                  key={h.url}
                  onClick={() => onOpen(h)}
                  {...rows.propsFor(`history:${h.url}`, () => onOpen(h), {
                    label: `${h.title || h.url}，${h.source_name}，${timeAgo(h.viewed_at)}`,
                  })}
                >
                  <div className="row-main">
                    <div className="row-title">{h.title || h.url}</div>
                    <div className="row-meta">
                      {h.source_name} · {timeAgo(h.viewed_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {visible.length === 0 && (
              <Empty title="没有匹配的记录" hint={`“${query.trim()}” 在已加载的 ${items.length} 条里没有匹配。`} />
            )}
            {items.length >= limit && (
              <div style={{ display: "flex", justifyContent: "center", padding: "12px 18px 20px" }}>
                <button
                  data-history-action="more"
                  onClick={() => load(limit + PAGE)}
                >
                  加载更多更早记录
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}