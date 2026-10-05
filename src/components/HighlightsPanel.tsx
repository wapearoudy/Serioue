import { useEffect, useState } from "react";
import { api, errorMessage, type Highlight } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";
import { preview } from "./highlight";

export function HighlightsPanel({
  onOpen,
  onClose,
}: {
  /** Open the article a highlight belongs to. */
  onOpen: (h: Highlight) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Highlight[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setItems(null);
    api
      .listHighlights()
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(load, []);

  const remove = async (h: Highlight) => {
    try {
      await api.removeHighlight(h.id);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const noted = items?.filter((h) => h.note).length ?? 0;

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">划线与笔记</div>
        <span className="spacer" />
        {items && items.length > 0 && (
          <span className="marks-count">
            {items.length} 条
            {noted > 0 && ` · ${noted} 条有笔记`}
          </span>
        )}
      </div>

      <div className="main-body">
        {error && <Banner text={error} onClose={() => setError(null)} />}
        {items === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="还没有划线"
            hint="在文章里选中一段文字，就会出现「高亮 / 笔记」两个按钮。划线会跟着这篇文章一起保存，下次打开还在原处。"
          />
        ) : (
          <div className="marks">
            {items.map((h) => (
              <div className="mark-row" key={h.id}>
                <div className="mark-row-main" onClick={() => onOpen(h)}>
                  <blockquote className="mark-quote">{preview(h.text, 140)}</blockquote>
                  {h.note && <div className="mark-note">{h.note}</div>}
                  <div className="mark-meta">
                    {h.title || h.url}
                    {h.source_name && ` · ${h.source_name}`}
                    {` · ${timeAgo(h.created_at)}`}
                  </div>
                </div>
                <button
                  className="ghost"
                  title="删除这条划线"
                  aria-label={`删除划线 ${preview(h.text, 30)}`}
                  onClick={() => void remove(h)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}