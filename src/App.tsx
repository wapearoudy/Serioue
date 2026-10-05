import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, events, shelfId, type ArticleItem, type ArticleResponse, type Category, type HistoryEntry, type ShelfEntry, type SourceSummary, type Stats, type UpdateInfo } from "./api";
import { ArticleList } from "./components/ArticleList";
import { HistoryPanel } from "./components/HistoryPanel";
import { Reader } from "./components/Reader";
import { RepoBrowser } from "./components/RepoBrowser";
import { ReaderStatsPanel } from "./components/ReaderStatsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShelfPanel } from "./components/ShelfPanel";
import { HighlightsPanel } from "./components/HighlightsPanel";
import { Sidebar, sourceMeta } from "./components/Sidebar";
import { UpdateBanner } from "./components/Update";
import { VerifyPanel } from "./components/VerifyPanel";
import { Banner, Empty } from "./components/ui";
import { applyReaderSettings } from "./components/ReaderSettings";
import type { Settings } from "./api";

type View =
  | { kind: "list" }
  | { kind: "reader"; item: ArticleItem }
  | { kind: "history" }
  | { kind: "shelf" }
  | { kind: "stats" }
  | { kind: "highlights" }
  | { kind: "verify" }
  | { kind: "settings" };

export default function App() {
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [showRepo, setShowRepo] = useState(false);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootBusy, setBootBusy] = useState(true);

  // Reader state
  const [article, setArticle] = useState<ArticleResponse | null>(null);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);
  /** The list entry's kind, so the reader can pick the right presentation. */
  const [articleKind, setArticleKind] = useState<string | null>(null);
  /** The list the reader opened from, used for the table of contents. */
  const [siblings, setSiblings] = useState<ArticleItem[]>([]);
  /** Sequence guards: only the newest request may write these. */
  const articleSeq = useRef(0);
  const siblingsSeq = useRef(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Bumped whenever a reading position moves, so the sidebar can refresh. */
  const [progressToken, setProgressToken] = useState(0);

  // Reader preferences drive CSS variables and the reading theme, so they are
  // loaded once at startup rather than when the reader first opens.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        applyReaderSettings(s);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const changeSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      applyReaderSettings(next);
      // Persist in the background; a failed write must not block reading.
      api.setSettings(next).catch(() => {});
      return next;
    });
  }, []);

  // Auto-update: the backend checks on startup and emits when one is found.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // The bookshelf lives in App because the list header's star, the shelf panel
  // and the sidebar count all have to agree about what is saved.
  const [shelf, setShelf] = useState<ShelfEntry[]>([]);
  const refreshShelf = useCallback(() => {
    api
      .listShelf()
      .then(setShelf)
      .catch(() => setShelf([]));
  }, []);
  useEffect(refreshShelf, [refreshShelf]);

  /** Only the count, for the sidebar tab. */
  const [highlightCount, setHighlightCount] = useState(0);
  const refreshHighlightCount = useCallback(() => {
    api
      .listHighlights()
      .then((list) => setHighlightCount(list.length))
      .catch(() => setHighlightCount(0));
  }, []);
  useEffect(refreshHighlightCount, [refreshHighlightCount]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    events
      .onUpdateAvailable((info) => {
        if (info.available) {
          setUpdate(info);
          setUpdateDismissed(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  const refreshSources = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.listSources(), api.stats()]);
      setSources(s);
      setStats(st);
      // Auto-select the first source on first load.
      setSelectedId((cur) => cur ?? (s.length > 0 ? s[0].id : null));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBootBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshSources();
  }, [refreshSources]);

  // Load categories whenever the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setCategories([]);
      return;
    }
    let cancelled = false;
    api
      .categories(selectedId)
      .then((res) => {
        if (!cancelled) setCategories(res.categories);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  /**
   * Make a source current and show its listing.
   *
   * There is exactly one of these on purpose. It used to exist three times —
   * the sidebar, the verify panel and 继续阅读 — and they drifted: the chapter
   * list was only cleared in one of them, so the reader's contents drawer
   * could offer the previous source's chapters.
   */
  function selectSource(id: string) {
    // Anything still in flight belongs to the source we are leaving.
    articleSeq.current += 1;
    siblingsSeq.current += 1;
    setSelectedId(id);
    setView({ kind: "list" });
    setArticle(null);
    setSiblings([]);
    setProgressToken((t) => t + 1);
  }

  /**
   * Load a source's listing so the reader has a table of contents for it.
   *
   * Without this, opening an article from history or from 继续阅读 leaves the
   * *previous* source's list in place, and the contents would offer the
   * chapters of a different book. Failing to load one is not an error — the
   * article still opens, it just has no chapter navigation.
   *
   * The sequence guard is what makes "the newest request wins" true: opening
   * two articles in quick succession would otherwise let whichever response
   * arrived last decide what the reader shows.
   */
  async function loadSiblingsFor(sourceId: string) {
    const seq = ++siblingsSeq.current;
    try {
      const page = await api.loadPage({ id: sourceId, url: null, page: 1 });
      if (seq !== siblingsSeq.current) return;
      setSiblings(page.items ?? []);
    } catch {
      if (seq === siblingsSeq.current) setSiblings([]);
    }
  }

  async function openArticle(item: ArticleItem) {
    if (!selectedId) return;
    const seq = ++articleSeq.current;
    setView({ kind: "reader", item });
    setArticleKind(item.kind);
    setArticleLoading(true);
    setArticleError(null);
    setArticle(null);
    void loadSiblingsFor(selectedId);
    try {
      const res = await api.loadArticle(selectedId, item.link, item.title);
      if (seq !== articleSeq.current) return;
      setArticle(res);
    } catch (e) {
      if (seq !== articleSeq.current) return;
      setArticleError(errorMessage(e));
    } finally {
      // Only the newest request may clear the spinner.
      if (seq === articleSeq.current) setArticleLoading(false);
    }
  }

  function openHistoryEntry(entry: HistoryEntry) {
    const seq = ++articleSeq.current;
    setView({ kind: "reader", item: { title: entry.title, link: entry.url, image: "", date: "", kind: "article" } });
    setArticleKind("article");
    setArticleLoading(true);
    setArticleError(null);
    setArticle(null);
    void loadSiblingsFor(entry.source_id);
    // History rows may belong to a source that is no longer selected.
    api
      .loadArticle(entry.source_id, entry.url, entry.title)
      .then((res) => {
        if (seq === articleSeq.current) setArticle(res);
      })
      .catch((e) => {
        if (seq === articleSeq.current) setArticleError(errorMessage(e));
      })
      .finally(() => {
        if (seq === articleSeq.current) setArticleLoading(false);
      });
  }

  const selected = sources.find((s) => s.id === selectedId) ?? null;

  /** Save or unsave the category the list is showing, as one "book". */
  const toggleShelf = useCallback(
    (sourceId: string, sourceName: string, categoryName: string, first?: ArticleItem) => {
      const id = shelfId(sourceId, categoryName);
      const saved = shelf.some((e) => e.id === id);
      const done = saved
        ? api.removeShelf(id)
        : api.addShelf({
            id,
            source_id: sourceId,
            source_name: sourceName,
            category: categoryName,
            // A list with nothing in it has no entry point yet; the shelf row still
            // works, it just opens an empty list.
            title: `${sourceName} · ${categoryName}`,
            url: first?.link ?? "",
            kind: first?.kind ?? "",
            added_at: 0,
          });
      done.then(refreshShelf).catch((e) => setError(errorMessage(e)));
    },
    [shelf, refreshShelf],
  );

  /** Open a shelf entry: switch source, then open the stored item. */
  const openShelfEntry = useCallback(
    (entry: ShelfEntry) => {
      selectSource(entry.source_id);
      void loadSiblingsFor(entry.source_id);
      if (!entry.url) {
        setView({ kind: "list" });
        return;
      }
      void api
        .loadArticle(entry.source_id, entry.url, entry.title)
        .then((res) => {
          setArticleKind(entry.kind || "article");
          setArticle(res);
          setView({
            kind: "reader",
            item: {
              title: entry.title,
              link: entry.url,
              image: "",
              date: "",
              kind: entry.kind || "article",
            },
          });
        })
        .catch((e) => setError(errorMessage(e)));
    },
    [],
  );

  return (
    <div className="app">
      <Sidebar
        sources={sources}
        selectedId={selectedId}
        onSelect={selectSource}
        onChanged={refreshSources}
        onOpenRepo={() => setShowRepo(true)}
        onOpenHistory={() => setView({ kind: "history" })}
        onOpenShelf={() => setView({ kind: "shelf" })}
        onOpenStats={() => setView({ kind: "stats" })}
        shelfCount={shelf.length}
        onOpenHighlights={() => setView({ kind: "highlights" })}
        highlightCount={highlightCount}
        onOpenVerify={() => setView({ kind: "verify" })}
        onOpenSettings={() => setView({ kind: "settings" })}
        stats={stats}
        filterOnlyFavorites={onlyFavorites}
        onToggleFilter={setOnlyFavorites}
        progressToken={progressToken}
        onContinue={(entry) => {
          // Resuming an article means switching to its source first, so the
          // category tabs and contents come from the right place.
          selectSource(entry.source_id);
          void loadSiblingsFor(entry.source_id);
          void api
            .loadArticle(entry.source_id, entry.url, entry.title)
            .then((res) => {
              setArticleKind("article");
              setArticle(res);
              setView({
                kind: "reader",
                item: { title: entry.title, link: entry.url, image: "", date: "", kind: "article" },
              });
            })
            .catch((e) => setError(errorMessage(e)));
        }}
        busy={bootBusy}
      />

      <main className="main">
        {error && <Banner text={error} onClose={() => setError(null)} />}

        {update && !updateDismissed && view.kind !== "settings" && (
          <UpdateBanner initial={update} onDismiss={() => setUpdateDismissed(true)} />
        )}

        {view.kind === "list" && selected && (
          <>
            <div className="main-head">
              <div className="main-title">
                {selected.name}
                <span>{sourceMeta(selected)}</span>
              </div>
              <span className="spacer" />
              <a href={selected.url} target="_blank" rel="noreferrer">
                <button title="在浏览器中打开源站">↗</button>
              </a>
            </div>
            <ArticleList
              sourceId={selected.id}
              sourceName={selected.name}
              categories={categories}
              onOpen={openArticle}
              onItemsChange={setSiblings}
              isOnShelf={(c) => shelf.some((e) => e.id === shelfId(selected.id, c))}
              onToggleShelf={({ category, first }) =>
                toggleShelf(selected.id, selected.name, category, first)
              }
            />
          </>
        )}

        {view.kind === "list" && !selected && !bootBusy && (
          <div className="main-head">
            <div className="main-title">Serious</div>
          </div>
        )}

        {view.kind === "list" && !selected && (
          <Empty
            title={bootBusy ? "正在加载…" : "还没有导入任何源"}
            hint="点击左上角「导入合集」，从源仓库挑选共享的订阅源合集；也可以在设置里粘贴 JSON 下载地址直接导入。"
            action={
              <button className="primary" onClick={() => setShowRepo(true)}>
                导入合集
              </button>
            }
          />
        )}

        {view.kind === "reader" && (
          <Reader
            loading={articleLoading}
            error={articleError}
            article={article}
            sourceName={selected?.name ?? ""}
            itemKind={articleKind ?? undefined}
            articleUrl={article?.final_url || undefined}
            siblings={siblings}
            currentLink={view.kind === "reader" ? view.item.link : undefined}
            currentSourceId={selected?.id}
            onOpenSibling={openArticle}
            settings={settings}
            onSettingsChange={changeSettings}
            onBack={() => {
              setView({ kind: "list" });
              // Leaving the reader is when a new reading position exists.
              setProgressToken((t) => t + 1);
            }}
            onOpenExternal={(url) => window.open(url, "_blank")}
          />
        )}

        {view.kind === "history" && (
          <HistoryPanel onOpen={openHistoryEntry} onClose={() => setView({ kind: "list" })} />
        )}

        {view.kind === "shelf" && (
          <ShelfPanel onOpen={openShelfEntry} onClose={() => setView({ kind: "list" })} />
        )}

        {view.kind === "stats" && (
          <ReaderStatsPanel onClose={() => setView({ kind: "list" })} />
        )}

        {view.kind === "highlights" && (
          <HighlightsPanel
            onOpen={(h) => {
              // Same shape as a history entry: switch to the source first, so
              // the category tabs and contents come from the right place.
              if (h.source_id) {
                selectSource(h.source_id);
                void loadSiblingsFor(h.source_id);
              }
              void api
                .loadArticle(h.source_id, h.url, h.title)
                .then((res) => {
                  setArticleKind("article");
                  setArticle(res);
                  setView({
                    kind: "reader",
                    item: { title: h.title, link: h.url, image: "", date: "", kind: "article" },
                  });
                })
                .catch((e) => setError(errorMessage(e)));
            }}
            onClose={() => setView({ kind: "list" })}
          />
        )}

        {view.kind === "verify" && (
          <VerifyPanel
            sources={sources}
            selectedId={selectedId}
            onSelect={selectSource}
            onBack={() => setView({ kind: "list" })}
            onChecked={refreshSources}
          />
        )}

        {view.kind === "settings" && (
          <SettingsPanel onSourcesChanged={refreshSources} onStatsChanged={refreshSources} />
        )}
      </main>

      {showRepo && (
        <RepoBrowser
          onClose={() => setShowRepo(false)}
          onImported={() => {
            refreshSources();
          }}
        />
      )}
    </div>
  );
}