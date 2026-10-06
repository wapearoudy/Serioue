import { useEffect, useState } from "react";
import { api, errorMessage, type HistoryEntry } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";
import { useKeyboardRows } from "./keyboardRow";

export function HistoryPanel({
  onOpen,
  onClose,
}: {
  onOpen: (entry: HistoryEntry) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useKeyboardRows();

  const load = () => {
    setItems(null);
    setError(null);
    api
      .listHistory(300)
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(load, []);

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">阅读历史</div>
        <span className="spacer" />
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
                onClick={load}
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
          <div className="list">
            {items.map((h) => (
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
        )}
      </div>
    </>
  );
}