import { useEffect, useState } from "react";
import { api, errorMessage, type HistoryEntry } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";

export function HistoryPanel({
  onOpen,
  onClose,
}: {
  onOpen: (entry: HistoryEntry) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setItems(null);
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
        {error && <Banner text={error} onClose={() => setError(null)} />}
        {items === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty title="还没有阅读记录" hint="打开任意一篇文章后会出现在这里。" />
        ) : (
          <div className="list">
            {items.map((h) => (
              <div className="row" key={h.url} onClick={() => onOpen(h)}>
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