import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type ArticleItem, type Category } from "../api";
import { Banner, Empty, Spinner, kindGlyph, kindLabel } from "./ui";
import { useKeyboardRows } from "./keyboardRow";
import "./article-list.css";

type Props = {
  sourceId: string;
  sourceName: string;
  categories: Category[];
  onOpen: (item: ArticleItem) => void;
  /**
   * Report the loaded items upwards.
   *
   * The list unmounts when the reader opens, so its contents have to live in
   * the parent if the reader is to show a table of contents for them.
   */
  onItemsChange?: (items: ArticleItem[]) => void;
  /** Whether the category currently on screen is already on the bookshelf. */
  isOnShelf?: (category: string) => boolean;
  /**
   * Save or unsave the category on screen.
   *
   * The category name is passed up rather than lifted: it is chosen here, and
   * the parent only needs it to build the shelf entry.
   */
  onToggleShelf?: (info: { category: string; first?: ArticleItem }) => void;
  /**
   * The category to show when this source's list is opened.
   *
   * Held by the parent because this list unmounts every time an article opens:
   * a reader in the third category, scrolled halfway down, used to land back on
   * the first category's top. It is the same reason the items are reported
   * upwards — the rest of where the reader was had nowhere to live.
   */
  initialCategoryIndex?: number;
  /** Report the category on screen so it can be remembered. */
  onCategoryIndexChange?: (index: number) => void;
  /** How far down this list the reader was when they left it. */
  initialScrollTop?: number;
  /** Report the scroll position so it can be restored next time. */
  onScrollTopChange?: (scrollTop: number) => void;
};

/** What the category listing currently holds. */
type Listing = { items: ArticleItem[]; next: string | null };
export function ArticleList({
  sourceId,
  sourceName,
  categories,
  onOpen,
  onItemsChange,
  isOnShelf,
  onToggleShelf,
  initialCategoryIndex = 0,
  onCategoryIndexChange,
  initialScrollTop = 0,
  onScrollTopChange,
}: Props) {
  const [catIndex, setCatIndex] = useState(initialCategoryIndex);
  // The category listing and the search results are kept apart on purpose.
  // Overwriting one with the other is what made 「清除」 a lie: clearing the box
  // restored nothing, and the user was left reading results with an empty search
  // field and no sign of where the content had come from.
  const [listing, setListing] = useState<Listing>({ items: [], next: null });
  /**
   * What the engine said about this page's rules, in words fit for a reader.
   *
   * `browse.rs` falls back to the page's raw links when a rule matches nothing,
   * so without this the reader gets a list that looks perfectly normal and never
   * learns their rule has been dead for months. It is `null` far more often than
   * not — an empty page is not a broken source, and the backend says so.
   */
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** A first-page failure: shown on its own, with a retry that repeats the call. */
  const [error, setError] = useState<string | null>(null);
  /** A later-page failure: the list above it is still perfectly usable. */
  const [moreError, setMoreError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  /** The search actually in force, or null while browsing. */
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<ArticleItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Bumped by 重试, so the same request can simply be sent again. */
  const [retryToken, setRetryToken] = useState(0);
  const rows = useKeyboardRows();

  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The offset the list is moving the scroller to on its own, if any.
   *
   * Resetting or restoring the scroller is not the reader scrolling, and
   * reporting it back as such would overwrite the position being restored. The
   * expectation is compared against what the scroller actually reached rather
   * than simply being cleared, because a move to the offset the container is
   * already at fires no event at all and a cleared flag would then swallow the
   * reader's next real scroll. */
  const programmaticScroll = useRef<number | null>(null);
  const category = categories[catIndex];
  const searching_ = query !== null;
  const items = searching_ ? results : listing.items;
  const busy = searching_ ? searching : loading;
  const failure = searching_ ? searchError : error;
  const firstLoad = busy && items.length === 0;

  // The parent owns which category this source's list opens on, because the
  // list is unmounted while the reader is open. The value is echoed back to it
  // on every change so it always holds the truth.
  //
  // These two effects and the parent's memory form a loop, so the rule is that
  // **only one of them writes the remembered index at a time**, and that the
  // report never fires while the list is still catching up. On mount — and on
  // every source switch — `catIndex` still holds the *previous* value for one
  // render, because `setCatIndex` above has not been applied yet. Reporting that
  // stale value writes the old source's category into the new source's slot. It
  // is corrected a render later, and it did converge in testing, but a correct
  // result reached by accident is not a result worth keeping: when it does not
  // converge it is the ArticleList freeze again, which pinned the main thread at
  // 100% and made the window unusable.
  //
  // So `adopting` holds the report back until the list has reached the value it
  // was told to adopt. A click on a tab clears it, because from then on every
  // change is the reader's own and must be reported.
  const adopting = useRef(true);
  useEffect(() => {
    adopting.current = true;
    setCatIndex(initialCategoryIndex);
  }, [initialCategoryIndex, sourceId]);

  const reportedSource = useRef(sourceId);
  useEffect(() => {
    if (reportedSource.current !== sourceId) {
      reportedSource.current = sourceId;
      return;
    }
    if (adopting.current) {
      // Stand down only once the list has actually caught up. An index the
      // parent gave that no longer exists (a category list that shrank) is
      // clamped, and must not keep this flag set forever — a tab click clears it.
      if (catIndex === initialCategoryIndex) adopting.current = false;
      return;
    }
    onCategoryIndexChange?.(catIndex);
  }, [catIndex, initialCategoryIndex, onCategoryIndexChange, sourceId]);

  // Switching sources must start from their first category. The previous index
  // can point past the end of a shorter list, and an out-of-range index falls
  // back to the site root — so the user would silently get the homepage of the
  // new source instead of the category tab they could actually see.
  //
  // It deliberately does **not** tell the parent to forget anything. The parent's
  // slot is keyed by source, and by the time this runs `selectedId` is already
  // the *new* source, so writing here would overwrite the position we just came
  // back to see. The new source's own value arrives through `initialCategoryIndex`
  // (which is 0 for a source never opened), and the effect above reports it once
  // this one has gone quiet.
  //
  // Getting this wrong is not a small thing. Writing 0 here while the report
  // effect wrote the real index made the two alternate, each one changing
  // `categoryUrl`, which re-ran the fetch, which re-rendered — a loop that
  // pinned the main thread at 100% and froze the window as soon as the reader
  // returned to a source they had left on a non-first category.
  //
  // The check is against the *previous* source, not against mounting: this list
  // is unmounted every time an article opens, so a plain mount check fired on
  // the way back too and wiped the position the reader had just left — which is
  // the exact bug this pairing exists to fix.
  const lastSource = useRef(sourceId);
  useEffect(() => {
    if (lastSource.current === sourceId) return;
    lastSource.current = sourceId;
    setKeyword("");
    // The scroller is deliberately *not* touched here. The restore effect below
    // owns it, and it knows what this source's position should be — resetting to
    // 0 here and restoring afterwards is two writers for one value, which is how
    // a remembered offset gets lost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  // Clamp when the category list shrinks underneath us.
  useEffect(() => {
    setCatIndex((i) => Math.min(i, Math.max(0, categories.length - 1)));
  }, [categories.length]);

  // A different source means the old listing describes a different site, so it
  // goes. A different *category* does not: keeping it is what stops the page
  // flashing empty on every tab click.
  useEffect(() => {
    setListing({ items: [], next: null });
  }, [sourceId]);

  // Moving to another category ends the search. The results belonged to the old
  // category's context, and leaving them up under a new tab is the same lie as
  // the one 「清除」 used to tell.
  useEffect(() => {
    setQuery(null);
    setResults([]);
    setSearchError(null);
  }, [sourceId, catIndex]);

  // Load the first page whenever the source or category changes, or when the
  // reader asks to retry.
  //
  // `categoryUrl` is in the dependencies on purpose. The parent fetches the
  // category list asynchronously, so on a source switch this effect first runs
  // with the *previous* source's categories. Without it in the deps the stale
  // URL is fetched once and never retried, leaving the user staring at the
  // other source's listing until they click a category tab.
  const categoryUrl = category?.url;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMoreError(null);
    // Cleared on every load, not left to be overwritten: the next category or
    // page may well be healthy, and a stale diagnosis would then be accusing a
    // source that just worked.
    setDiagnosis(null);

    api
      .loadPage({ id: sourceId, url: categoryUrl, page: 1 })
      .then((res) => {
        if (cancelled) return;
        setListing({ items: res.items, next: res.next });
        setNext(res.next);
        setDiagnosis(res.diagnosis ?? null);
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
  }, [sourceId, catIndex, categoryUrl, retryToken]);

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
    if (!next || loadingMore || loading || searching_) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api.loadPage({ id: sourceId, url: category?.url, next });
      setListing((prev) => {
        const seen = new Set(prev.items.map((i) => i.link));
        const fresh = res.items.filter((i) => !seen.has(i.link));
        return { items: [...prev.items, ...fresh], next: res.next };
      });
      setNext(res.next);
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  // Keep the parent in step with whatever is currently listed.
  useEffect(() => {
    onItemsChange?.(items);
  }, [items, onItemsChange]);

  /**
   * Put the reader back where they were — the single owner of the scroller.
   *
   * Three things make this harder than it looks:
   *
   * - **The container is empty on the first paint.** Assigning an offset to a
   *   box that is not tall enough does not fail, it is silently clamped to
   *   whatever fits — so one attempt at the wrong moment looks exactly like
   *   "your place was lost". It keeps trying for a few frames until the offset
   *   actually sticks.
   * - **It must not fight a live scroll.** The reported position arrives through
   *   `initialScrollTop`, so an effect keyed on it would re-fire on every frame
   *   of a drag and pull the reader backwards. `restored` records which
   *   (source, row count) has already been dealt with, so the position is
   *   applied when the list is new or refills — and only then.
   * - **Zero is a position too.** A source the reader has never opened starts
   *   at the top, so this is also what moves the list off the previous source's
   *   offset on a switch.
   */
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (new URLSearchParams(location.search).has("noRestore")) return;
    if (searching_) return;
    const el = scroller.current;
    if (!el) return;
    const key = `${sourceId}:${listing.items.length}`;
    if (restored.current === key) return;
    restored.current = key;
    const want = initialScrollTop;
    let tries = 0;
    const step = () => {
      const landed = want <= 0 ? el.scrollTop === 0 : Math.round(el.scrollTop) === Math.round(want);
      if (landed || tries >= 8) return;
      tries += 1;
      programmaticScroll.current = want;
      el.scrollTop = want;
      raf = requestAnimationFrame(step);
    };
    let raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [sourceId, listing.items.length, searching_, initialScrollTop]);

  // Report the position continuously, so the value is current whenever the
  // reader leaves — including by opening an article, which unmounts this list.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !onScrollTopChange) return;
    if (new URLSearchParams(location.search).has("noScrollReport")) return;
    let last = 0;
    const onScroll = () => {
      const top = el.scrollTop;
      if (top === last) return;
      // An empty (or barely loaded) list cannot be scrolled, so the browser
      // pins the offset to 0. Reporting that would overwrite the position the
      // reader actually left with — and the restore would then have nothing to
      // go back to.
      if (el.scrollHeight <= el.clientHeight) return;
      // This move was the list's own. Swallowing exactly one event is not safe on
      // its own — moving to the offset the container already sits at fires
      // nothing — so the expectation is matched instead of simply cleared.
      const expected = programmaticScroll.current;
      if (expected !== null && Math.round(top) === Math.round(expected)) {
        programmaticScroll.current = null;
        last = top;
        return;
      }
      programmaticScroll.current = null;
      last = top;
      onScrollTopChange(top);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [onScrollTopChange]);

  async function runSearch(term: string) {
    // The screen belongs to the search from the moment it starts, not from the
    // moment it succeeds. Holding on to the old behaviour — only switching state
    // once results arrived — meant a failed search was swallowed: the error was
    // recorded, the category listing stayed up, and nothing told the reader
    // anything had gone wrong.
    setQuery(term);
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.searchSource(sourceId, term);
      setResults(res.items);
      // The backend diagnoses search results the same way it does a listing, and
      // a search that quietly fell back to raw links deserves the same warning.
      setDiagnosis(res.diagnosis ?? null);
    } catch (err) {
      setSearchError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const kw = keyword.trim();
    if (!kw) return;
    await runSearch(kw);
  }

  /** Back to the category listing: no refetch, because it was never thrown away. */
  function clearSearch() {
    setKeyword("");
    setQuery(null);
    setResults([]);
    setSearchError(null);
    // Back to browsing: whatever the search said about the rules does not apply
    // to the category listing, and leaving it up would accuse a list that is
    // about to be shown and is probably fine.
    setDiagnosis(null);
  }

  /** Repeat whichever request failed, with the same arguments. */
  function retry() {
    if (searching_) {
      if (query) void runSearch(query);
      return;
    }
    setError(null);
    setRetryToken((t) => t + 1);
  }

  const saved = isOnShelf?.(category?.name ?? "") ?? false;

  return (
    <>
      {onToggleShelf && !searching_ && (
        <div className="shelf-bar">
          <button
            className={saved ? "on" : ""}
            onClick={() => onToggleShelf({ category: category?.name ?? "", first: listing.items[0] })}
            title={saved ? "从书架移除这个分类" : "把这个分类收进书架"}
          >
            {saved ? "★" : "☆"} {saved ? "已在书架" : "收进书架"}
          </button>
          <span className="shelf-bar-hint">收的是「{category?.name ?? "当前分类"}」这一整个列表</span>
        </div>
      )}
      {categories.length > 1 && (
        <div className="cat-bar">
          {categories.map((c, i) => (
            <button
              key={`${c.name}-${i}`}
              className={`cat${i === catIndex ? " active" : ""}`}
              onClick={() => {
                // From here on the change is the reader's, so it is reported even
                // if the parent still holds an index this list cannot use.
                adopting.current = false;
                setCatIndex(i);
                // A different list starts at its top; the offset belongs to the
                // category the reader just left. The restore effect does not see
                // a category change, so this move is made here — and marked, so
                // the browser's own scroll event for it is not reported as if the
                // reader had done it.
                if (scroller.current) {
                  programmaticScroll.current = 0;
                  scroller.current.scrollTop = 0;
                }
                onScrollTopChange?.(0);
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={search} style={{ padding: "10px 18px 0", display: "flex", gap: 8 }}>
        <input
          aria-label={`在「${sourceName}」中搜索`}
          placeholder={`在「${sourceName}」中搜索…`}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button type="submit" disabled={searching}>
          {searching ? "搜索中…" : "搜索"}
        </button>
        {keyword && (
          <button type="button" className="ghost" onClick={clearSearch}>
            清除
          </button>
        )}
      </form>

      {/*
        Where am I? A search result list that looks like a category list is how
        a reader ends up believing the category only has three entries.
      */}
      {searching_ && !searchError && (
        <div className="list-context" data-list-context="search" role="status">
          <span>
            「{query}」的搜索结果 · {results.length} 条
          </span>
          <span className="spacer" />
          <button
            type="button"
            data-list-action="back-to-list"
            aria-label="回到分类列表"
            onClick={clearSearch}
          >
            回到分类列表
          </button>
        </div>
      )}

      {moreError && (
        <Banner
          text={moreError}
          action={
            <button className="primary" data-list-action="retry-more" onClick={() => void loadMore()}>
              重试
            </button>
          }
          onClose={() => setMoreError(null)}
        />
      )}

      {/*
        Above the scrolling body, so it stays put while the list scrolls past, and
        never inside `.main-body`: a row among the articles is a row a reader can
        click, and this one is not an article. `role="status"` so it is announced
        when it appears — a silent correction is one nobody reads. Rendered only
        when there is something to say, so a healthy list gains no node at all.
      */}
      {diagnosis && (
        <div className="list-diagnosis" data-list-diagnosis="1" role="status">
          {diagnosis}
        </div>
      )}

      <div className="main-body" aria-busy={busy} ref={scroller}>
        {failure ? (
          <Empty
            title={searching_ ? "搜索没有成功" : "没能加载这个分类"}
            hint={failure}
            action={
              <button className="primary" data-list-action="retry" onClick={retry}>
                重试
              </button>
            }
          />
        ) : firstLoad ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title={searching_ ? "没有搜到相关的内容" : "这个分类没有内容"}
            hint={
              searching_
                ? "换个关键词再试一次，或者回到分类列表继续浏览。"
                : "可以换一个分类，或用上方的搜索框试试。也可以运行「检测全部」确认源是否仍然可用。"
            }
            action={
              searching_ ? (
                <button data-list-action="back-to-list" onClick={clearSearch}>
                  回到分类列表
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/*
              While the next category is on its way the old list stays put,
              dimmed. Clearing it first is what made every tab click flash white
              and lose the reading position.
            */}
            <div className="grid" data-list-state={busy ? "stale" : "fresh"}>
              {items.map((item, i) => {
                const key = `${item.link}-${i}`;
                const label = `${item.title || item.link}，${kindLabel(item.kind)}${
                  item.date ? `，${item.date}` : ""
                }`;
                return (
                  <div
                    className="card"
                    key={key}
                    onClick={() => onOpen(item)}
                    // The shared row behaviour, rather than the hand-rolled copy
                    // this file grew in the previous round: a keyboard user has to
                    // be able to open an article, and ten copies of "role +
                    // tabIndex + Enter/Space" is how the tenth one ends up
                    // missing the focus ring or the nested-control guard.
                    {...rows.propsFor(`card:${key}`, () => onOpen(item), { label })}
                    data-card="1"
                  >
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
                );
              })}
            </div>
            <div ref={sentinel} style={{ padding: 20, textAlign: "center" }}>
              {searching_ ? (
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  搜索结果 · 共 {items.length} 条
                </span>
              ) : loadingMore ? (
                <Spinner />
              ) : next ? (
                <button onClick={() => void loadMore()}>加载更多</button>
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
