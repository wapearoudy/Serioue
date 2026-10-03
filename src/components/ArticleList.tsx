import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type ArticleItem, type Category } from "../api";
import { Banner, Empty, Spinner, kindGlyph, kindLabel } from "./ui";

type Props = {
  sourceId: string;
  sourceName: string;
  categories: Category[];
  onOpen: (item: ArticleItem) => void;
};

export function ArticleList({ sourceId, sourceName, categories, onOpen }: Props) {
  const [catIndex, setCatIndex] = useState(0);
  const [items, setItems] = useState<ArticleItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);

  const sentinel = useRef<HTMLDivElement>(null);
  const category = categories[catIndex];

  // Load the first page whenever the source or category changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setNext(null);

    api
      .loadPage({ id: sourceId, url: category?.url, page: 1 })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setNext(res.next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, catIndex]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, loadingMore, loading]);

  async function loadMore() {
    if (!next || loadingMore || loading) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await api.loadPage({ id: sourceId, url: category?.url, next });
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.link));
        const fresh = res.items.filter((i) => !seen.has(i.link));
        return [...prev, ...fresh];
      });
      setNext(res.next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setError(null);
    try {
      const res = await api.searchSource(sourceId, kw);
      setItems(res.items);
      setNext(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  return (
    <>
      {categories.length > 1 && (
        <div className="cat-bar">
          {categories.map((c, i) => (
            <button
              key={`${c.name}-${i}`}
              className={`cat${i === catIndex ? " active" : ""}`}
              onClick={() => setCatIndex(i)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={search} style={{ padding: "10px 18px 0", display: "flex", gap: 8 }}>
        <input
          placeholder={`在「${sourceName}」中搜索…`}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button type="submit" disabled={searching}>
          {searching ? "搜索中…" : "搜索"}
        </button>
        {keyword && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setKeyword("");
              setCatIndex((c) => c);
            }}
          >
            清除
          </button>
        )}
      </form>

      {error && <Banner text={error} onClose={() => setError(null)} />}

      <div className="main-body">
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="这个分类没有内容"
            hint="可以换一个分类，或用上方的搜索框试试。也可以运行「检测全部」确认源是否仍然可用。"
          />
        ) : (
          <>
            <div className="grid">
              {items.map((item, i) => (
                <div className="card" key={`${item.link}-${i}`} onClick={() => onOpen(item)}>
                  <div
                    className="card-thumb"
                    style={
                      item.image ? { backgroundImage: `url("${CSS.escape(item.image)}")` } : undefined
                    }
                  >
                    {!item.image && kindGlyph(item.kind)}
                  </div>
                  <div className="card-body">
                    <div className="card-title">{item.title}</div>
                    <div className="card-meta">
                      <span>{kindLabel(item.kind)}</span>
                      {item.date && <span>· {item.date}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div ref={sentinel} style={{ padding: 20, textAlign: "center" }}>
              {loadingMore ? (
                <Spinner />
              ) : next ? (
                <button onClick={loadMore}>加载更多</button>
              ) : (
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  没有更多了（共 {items.length} 条）
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}