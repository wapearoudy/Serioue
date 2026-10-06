import { useEffect, useState } from "react";
import { api, errorMessage, type ShelfProgress } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";
import { useKeyboardRows } from "./keyboardRow";

export function ShelfPanel({
  onOpen,
  onClose,
}: {
  /** Open an entry: switch to its source, then open the stored item. */
  onOpen: (entry: ShelfProgress["entry"]) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ShelfProgress[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useKeyboardRows();

  const load = () => {
    setItems(null);
    setError(null);
    api
      .shelfProgress()
      .then((list) => setItems(list))
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(load, []);

  const remove = async (id: string) => {
    try {
      await api.removeShelf(id);
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
        {error && (
          // Each shelf entry is fetched from a live source, so this fails often
          // and intermittently — repeating the load is the whole point.
          <Banner
            text={error}
            action={
              <button
                className="primary"
                data-retry="shelf"
                aria-label="重试加载书架"
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
          <Empty
            title="书架还是空的"
            hint="在任意源的分类列表里点标题栏的 ☆，就会把这一整个分类收进书架，之后可以从这里直接回去读。"
          />
        ) : (
          <div className="list">
            {items.map((p) => {
              const entry = p.entry;
              const known = p.total !== null && p.total > 0;
              const pct = known ? Math.round((p.finished / (p.total as number)) * 100) : 0;
              return (
                <div
                  className="row"
                  key={entry.id}
                  onClick={() => onOpen(entry)}
                  {...rows.propsFor(`shelf:${entry.id}`, () => onOpen(entry), {
                    label: `${entry.title || entry.url}，${entry.source_name}${
                      entry.category ? `，${entry.category}` : ""
                    }`,
                  })}
                >
                  <div className="row-main">
                    <div className="row-title">{entry.title || entry.url}</div>
                    <div className="row-meta">
                      {entry.source_name}
                      {entry.category && entry.category !== "全部" && ` · ${entry.category}`}
                      {` · ${timeAgo(entry.added_at)}`}
                    </div>
                    {known ? (
                      <>
                        <div
                          className="row-progress"
                          title={`读完 ${p.finished} / ${p.total} 章${p.note ? ` · ${p.note}` : ""}`}
                        >
                          <div style={{ width: `${pct}%` }} />
                        </div>
                        <div className="shelf-read">
                          已读 {p.finished} / {p.total} 章 · {pct}%
                          {p.partial > 0 && ` · 另有 ${p.partial} 章读到一半`}
                          {p.note && ` · ${p.note}`}
                        </div>
                      </>
                    ) : (
                      <div className="shelf-read shelf-read-unknown">{p.note}</div>
                    )}
                  </div>
                  <button
                    className="ghost"
                    title="从书架移除"
                    aria-label={`从书架移除 ${entry.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(entry.id);
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