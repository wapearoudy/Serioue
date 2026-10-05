import { useEffect, useState } from "react";
import { api, errorMessage, type ShelfEntry } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";

export function ShelfPanel({
  onOpen,
  onClose,
}: {
  /** Open an entry: switch to its source, then open the stored item. */
  onOpen: (entry: ShelfEntry) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ShelfEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Reading position per entry, keyed by the entry's stored url. */
  const [at, setAt] = useState<Record<string, number>>({});

  const load = () => {
    setItems(null);
    api
      .listShelf()
      .then((list) => {
        // Newest first, matching the backend's order. Sorted here too so the
        // panel is correct even if the backend ever stops guaranteeing it.
        setItems([...list].sort((a, b) => b.added_at - a.added_at));
        // One round trip for the whole shelf; asking per row would be N calls.
        if (list.length > 0) {
          api
            .getProgressMany(list.map((e) => e.url))
            .then(setAt)
            .catch(() => setAt({}));
        }
      })
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(load, []);

  const remove = async (entry: ShelfEntry) => {
    try {
      await api.removeShelf(entry.id);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">书架</div>
      </div>

      <div className="main-body">
        {error && <Banner text={error} onClose={() => setError(null)} />}
        {items === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="书架还是空的"
            hint="在任意源的分类列表里点标题栏的 ☆，就会把这一整个分类收进书架，之后可以从这里直接回去读。"
          />
        ) : (
          <div className="list">
            {items.map((entry) => {
              const ratio = at[entry.url] ?? 0;
              return (
                <div className="row" key={entry.id} onClick={() => onOpen(entry)}>
                  <div className="row-main">
                    <div className="row-title">{entry.title || entry.url}</div>
                    <div className="row-meta">
                      {entry.source_name}
                      {entry.category && entry.category !== "全部" && ` · ${entry.category}`}
                      {` · ${timeAgo(entry.added_at)}`}
                    </div>
                    {ratio > 0 && ratio < 0.98 && (
                      <div className="row-progress" title={`已读 ${Math.round(ratio * 100)}%`}>
                        <div style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                    )}
                  </div>
                  <button
                    className="ghost"
                    title="从书架移除"
                    aria-label={`从书架移除 ${entry.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(entry);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}