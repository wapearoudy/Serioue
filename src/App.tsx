import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, events, type ArticleItem, type ArticleResponse, type Category, type HistoryEntry, type SourceSummary, type Stats, type UpdateInfo } from "./api";
import { ArticleList } from "./components/ArticleList";
import { HistoryPanel } from "./components/HistoryPanel";
import { Reader } from "./components/Reader";
import { RepoBrowser } from "./components/RepoBrowser";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar, sourceMeta } from "./components/Sidebar";
import { UpdateBanner } from "./components/Update";
import { Banner, Empty } from "./components/ui";

type View =
  | { kind: "list" }
  | { kind: "reader"; item: ArticleItem }
  | { kind: "history" }
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

  // Auto-update: the backend checks on startup and emits when one is found.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

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

  async function openArticle(item: ArticleItem) {
    if (!selectedId) return;
    setView({ kind: "reader", item });
    setArticleLoading(true);
    setArticleError(null);
    setArticle(null);
    try {
      const res = await api.loadArticle(selectedId, item.link, item.title);
      setArticle(res);
    } catch (e) {
      setArticleError(errorMessage(e));
    } finally {
      setArticleLoading(false);
    }
  }

  function openHistoryEntry(entry: HistoryEntry) {
    setView({ kind: "reader", item: { title: entry.title, link: entry.url, image: "", date: "", kind: "article" } });
    setArticleLoading(true);
    setArticleError(null);
    setArticle(null);
    // History rows may belong to a source that is no longer selected.
    api
      .loadArticle(entry.source_id, entry.url, entry.title)
      .then(setArticle)
      .catch((e) => setArticleError(errorMessage(e)))
      .finally(() => setArticleLoading(false));
  }

  const selected = sources.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar
        sources={sources}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setView({ kind: "list" });
          setArticle(null);
        }}
        onChanged={refreshSources}
        onOpenRepo={() => setShowRepo(true)}
        onOpenHistory={() => setView({ kind: "history" })}
        onOpenSettings={() => setView({ kind: "settings" })}
        stats={stats}
        filterOnlyFavorites={onlyFavorites}
        onToggleFilter={setOnlyFavorites}
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
            onBack={() => setView({ kind: "list" })}
            onOpenExternal={(url) => window.open(url, "_blank")}
          />
        )}

        {view.kind === "history" && (
          <HistoryPanel onOpen={openHistoryEntry} onClose={() => setView({ kind: "list" })} />
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