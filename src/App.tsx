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
import { Titlebar } from "./components/Titlebar";
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
  /**
   * Where a panel should go back to.
   *
   * Opening 划线 or 设置 from the sidebar while reading dropped the reader on
   * the list afterwards, so "look at one thing, then carry on reading" — the
   * reason they opened it — cost them a re-open of the article. One slot is
   * enough: the panels are siblings, not a tree.
   */
  const [panelReturn, setPanelReturn] = useState<View | null>(null);
  /**
   * Where the reader was in each source's list.
   *
   * The list unmounts while an article is open, so the category and the scroll
   * offset had nowhere to live, and every return started again at the first
   * category scrolled to the top.
   */
  const [listSession, setListSession] = useState<Record<string, { catIndex: number; scrollTop: number }>>({});
  const session = selectedId ? listSession[selectedId] : undefined;

  // Stable identities matter here: the list reports its category and scroll
  // position through these, and an inline arrow would change identity on every
  // render, re-running the list's effects, which write back — a render loop
  // that pegs the main thread rather than anything visible going wrong.
  const rememberCategory = useCallback((index: number) => {
    if (!selectedId) return;
    setListSession((prev) => {
      const cur = prev[selectedId];
      if (cur && cur.catIndex === index) return prev;
      return { ...prev, [selectedId]: { catIndex: index, scrollTop: cur?.scrollTop ?? 0 } };
    });
  }, [selectedId]);

  const rememberScroll = useCallback((top: number) => {
    if (!selectedId) return;
    setListSession((prev) => {
      const cur = prev[selectedId];
      if (cur && cur.scrollTop === top) return prev;
      return { ...prev, [selectedId]: { catIndex: cur?.catIndex ?? 0, scrollTop: top } };
    });
  }, [selectedId]);
  const [showRepo, setShowRepo] = useState(false);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  /**
   * The app-level failure, with the request that caused it.
   *
   * This used to be a bare string, so every failure here produced a banner with
   * nothing but a close button: the app knew exactly what had failed and what
   * would fix it, and showed the reader neither. Carrying the retry alongside the
   * message is what lets each throw site say what to do about itself — 「重试」
   * means one specific request, not "try the app again".
   */
  const [error, setError] = useState<{ text: string; retry?: () => void } | null>(null);
  const [bootBusy, setBootBusy] = useState(true);

  /** Report a failure together with the one action that can undo it. */
  const failWith = useCallback((e: unknown, retry?: () => void) => {
    setError({ text: errorMessage(e), retry });
  }, []);
  /** A retry that first clears the banner, so it does not sit there mid-flight. */
  const retryThen = useCallback((retry: () => void) => {
    return () => {
      setError(null);
      retry();
    };
  }, []);

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
  const loadSettings = useCallback(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        applyReaderSettings(s);
      })
      .catch((e) => failWith(e, retryThen(loadSettings)));
  }, [failWith, retryThen]);
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

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
      // Settled separately on purpose. `Promise.all` throws away a source list
      // that arrived perfectly well just because the sidebar's counts did not,
      // and the result is an app that looks empty over a number the reader never
      // asked for. Each half is worth showing on its own merits, and whichever
      // half failed still says so, with its own retry.
      const [listResult, statsResult] = await Promise.allSettled([
        api.listSources(),
        api.stats(),
      ]);
      if (listResult.status === "fulfilled") {
        const s = listResult.value;
        setSources(s);
        // Auto-select the first source on first load.
        setSelectedId((cur) => cur ?? (s.length > 0 ? s[0].id : null));
      }
      if (statsResult.status === "fulfilled") setStats(statsResult.value);
      if (listResult.status === "rejected") {
        failWith(listResult.reason, retryThen(refreshSources));
      } else if (statsResult.status === "rejected") {
        // Only one message fits in the banner, and the retry re-issues both, so
        // naming whichever failed first is not hiding anything actionable.
        failWith(statsResult.reason, retryThen(refreshSources));
      }
    } catch (e) {
      // Reachable only if something above throws rather than rejects.
      failWith(e, retryThen(refreshSources));
    } finally {
      setBootBusy(false);
    }
  }, [failWith, retryThen]);

  useEffect(() => {
    refreshSources();
  }, [refreshSources]);

  // Load categories whenever the selection changes.
  const loadCategories = useCallback((id: string) => {
    return () => {
      api
        .categories(id)
        .then((res) => setCategories(res.categories))
        .catch((e) => failWith(e, retryThen(loadCategories(id))));
    };
  }, [failWith, retryThen]);
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
        if (!cancelled) failWith(e, retryThen(loadCategories(selectedId)));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, failWith, loadCategories, retryThen]);

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
    setPanelReturn(null);
    setArticle(null);
    setSiblings([]);
    setProgressToken((t) => t + 1);
  }

  /** Open a panel, remembering the reader if that is where they were. */
  function openPanel(next: View) {
    setPanelReturn((prev) => (view.kind === "reader" ? view : prev));
    setView(next);
  }

  /** Close a panel: back to the reader if it came from one, else to the list. */
  function closePanel() {
    setView((current) => {
      void current;
      return panelReturn ?? { kind: "list" };
    });
    setPanelReturn(null);
  }

  /** Leave the reader. Also the moment a new reading position exists. */
  function leaveReader() {
    setView({ kind: "list" });
    setProgressToken((t) => t + 1);
  }

  /**
   * One 「返回」 for the keyboard and the button.
   *
   * Escape is what people press when a screen is in the way, and in a desktop
   * app pressing it on the main screens doing nothing reads as the app being
   * stuck. Two places keep their own Escape and are left alone: the reader's
   * settings popover (it closes itself) and the video player (Escape is its
   * fullscreen key by design).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (target?.closest(".reader-settings, .player-wrap")) return;
      if (panelReturn) {
        closePanel();
      } else if (view.kind === "reader") {
        leaveReader();
      }
      // On the list there is nothing above it, so Escape deliberately does
      // nothing rather than pretending.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.kind, panelReturn]);

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

  /**
   * Open an article that belongs to some source, not necessarily the selected one.
   *
   * History, the bookshelf, 「继续阅读」 and a highlight all point at a stored
   * source, so they cannot go through `openArticle` — that one reads `selectedId`,
   * which is still the *previous* source at the moment they run.
   *
   * The view is switched **before** the fetch, which is the whole point: a failure
   * used to leave the reader sitting on the panel it was opened from, with only an
   * app-level banner offering a close button. Opening first means the reader's own
   * error — and the 「重试」 that comes with it — is on screen, which is where the
   * reader already is looking.
   */
  const openArticleOf = useCallback(
    (sourceId: string, item: ArticleItem, kind: string) => {
      const seq = ++articleSeq.current;
      selectSource(sourceId);
      setView({ kind: "reader", item });
      setArticleKind(kind || item.kind);
      setArticleLoading(true);
      setArticleError(null);
      setArticle(null);
      void loadSiblingsFor(sourceId);
      api
        .loadArticle(sourceId, item.link, item.title)
        .then((res) => {
          if (seq === articleSeq.current) setArticle(res);
        })
        .catch((e) => {
          if (seq === articleSeq.current) setArticleError(errorMessage(e));
        })
        .finally(() => {
          if (seq === articleSeq.current) setArticleLoading(false);
        });
    },
    [selectSource, loadSiblingsFor],
  );

  function openHistoryEntry(entry: HistoryEntry) {
    openArticleOf(
      entry.source_id,
      { title: entry.title, link: entry.url, image: "", date: "", kind: "article" },
      "article",
    );
  }

  const selected = sources.find((s) => s.id === selectedId) ?? null;

  /** Save or unsave the category the list is showing, as one "book". */
  const toggleShelf = useCallback(
    (sourceId: string, sourceName: string, categoryName: string, first?: ArticleItem) => {
      const id = shelfId(sourceId, categoryName);
      const saved = shelf.some((e) => e.id === id);
      // The retry re-runs the whole toggle, so it reads `shelf` at that moment
      // rather than the one captured here — after a failed write nothing changed,
      // but re-deciding is what keeps a second failure from inverting the action.
      const write = () =>
        toggleShelf(sourceId, sourceName, categoryName, first);
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
      done.then(refreshShelf).catch((e) => failWith(e, retryThen(write)));
    },
    [shelf, refreshShelf, failWith, retryThen],
  );

  /** Open a shelf entry: switch source, then open the stored item. */
  const openShelfEntry = useCallback(
    (entry: ShelfEntry) => {
      if (!entry.url) {
        selectSource(entry.source_id);
        setView({ kind: "list" });
        return;
      }
      openArticleOf(
        entry.source_id,
        { title: entry.title, link: entry.url, image: "", date: "", kind: entry.kind || "article" },
        entry.kind || "article",
      );
    },
    [openArticleOf, selectSource],
  );

  return (
    <div className="app">
      <Sidebar
        sources={sources}
        selectedId={selectedId}
        onSelect={selectSource}
        onChanged={refreshSources}
        onOpenRepo={() => setShowRepo(true)}
        onOpenHistory={() => openPanel({ kind: "history" })}
        onOpenShelf={() => openPanel({ kind: "shelf" })}
        onOpenStats={() => openPanel({ kind: "stats" })}
        shelfCount={shelf.length}
        onOpenHighlights={() => openPanel({ kind: "highlights" })}
        highlightCount={highlightCount}
        onOpenVerify={() => openPanel({ kind: "verify" })}
        onOpenSettings={() => openPanel({ kind: "settings" })}
        stats={stats}
        filterOnlyFavorites={onlyFavorites}
        onToggleFilter={setOnlyFavorites}
        progressToken={progressToken}
        onContinue={(entry) => {
          // Resuming an article means switching to its source first, so the
          // category tabs and contents come from the right place.
          openArticleOf(
            entry.source_id,
            { title: entry.title, link: entry.url, image: "", date: "", kind: "article" },
            "article",
          );
        }}
        busy={bootBusy}
      />

      <main className="main">
        <Titlebar
          crumb={
            view.kind === "list"
              ? selected
                ? selected.name
                : "Serious"
              : view.kind === "reader"
                ? selected?.name ?? "Serious"
                : view.kind === "history"
                  ? "阅读历史"
                  : view.kind === "shelf"
                    ? "书架"
                    : view.kind === "stats"
                      ? "阅读统计"
                      : view.kind === "highlights"
                        ? "划线与笔记"
                        : view.kind === "verify"
                          ? "源校验"
                          : "设置"
          }
          sub={
            view.kind === "list" && selected
              ? sourceMeta(selected)
              : view.kind === "list"
                ? "从左侧选择一个源开始"
                : undefined
          }
          homeUrl={view.kind === "list" ? selected?.url : undefined}
        />
        {error && (
          <Banner
            text={error.text}
            action={
              error.retry ? (
                <button className="primary" data-retry="app" onClick={error.retry} aria-label="重试">
                  重试
                </button>
              ) : undefined
            }
            onClose={() => setError(null)}
          />
        )}

        {update && !updateDismissed && view.kind !== "settings" && (
          <UpdateBanner initial={update} onDismiss={() => setUpdateDismissed(true)} />
        )}

        {view.kind === "list" && selected && (
          <>
            <div className="main-head main-head--sub">
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
              // Coming back from an article lands where the reader left off.
              initialCategoryIndex={session?.catIndex ?? 0}
              onCategoryIndexChange={rememberCategory}
              initialScrollTop={session?.scrollTop ?? 0}
              onScrollTopChange={rememberScroll}
              isOnShelf={(c) => shelf.some((e) => e.id === shelfId(selected.id, c))}
              onToggleShelf={({ category, first }) =>
                toggleShelf(selected.id, selected.name, category, first)
              }
            />
          </>
        )}

        {view.kind === "list" && !selected && !bootBusy && (
          <div className="main-head main-head--sub">
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
            // The reader's own error, not the app-wide one: it belongs to a
            // single request, so it can be dismissed on its own and repeated.
            onErrorClose={() => setArticleError(null)}
            onRetry={
              view.kind === "reader"
                ? () => void openArticle(view.item)
                : undefined
            }
            onBack={leaveReader}
            onOpenExternal={(url) => window.open(url, "_blank")}
          />
        )}

        {view.kind === "history" && <HistoryPanel onOpen={openHistoryEntry} onClose={closePanel} />}

        {view.kind === "shelf" && <ShelfPanel onOpen={openShelfEntry} onClose={closePanel} />}

        {view.kind === "stats" && <ReaderStatsPanel onClose={closePanel} />}

        {view.kind === "highlights" && (
          <HighlightsPanel
            onOpen={(h) => {
              // Same shape as a history entry: switch to the source first, so
              // the category tabs and contents come from the right place. A
              // highlight with no source recorded still opens, just without one.
              openArticleOf(
                h.source_id,
                { title: h.title, link: h.url, image: "", date: "", kind: "article" },
                "article",
              );
            }}
            onClose={closePanel}
          />
        )}

        {view.kind === "verify" && (
          <VerifyPanel
            sources={sources}
            selectedId={selectedId}
            onSelect={selectSource}
            onBack={closePanel}
            onChecked={refreshSources}
          />
        )}

        {view.kind === "settings" && (
          <SettingsPanel
            onSourcesChanged={refreshSources}
            onStatsChanged={refreshSources}
            onClose={closePanel}
          />
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