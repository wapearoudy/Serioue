// Development harness for keyboard operation of the list-shaped surfaces.
//
// Mounts the real Sidebar, HistoryPanel, ShelfPanel, HighlightsPanel,
// ArticleList, VerifyPanel, Reader contents and MusicPlayer queue against a
// stubbed backend, so each row can be reached with Tab and operated with Enter
// or Space — the way a keyboard user would, rather than by calling onClick.
// Opened at /reader-nav-preview.html while `pnpm dev` runs; never bundled.
//
//   ?failContinue=1  make 继续阅读 fail, to see the light hint
//
// Everything a keyboard action should change is written into `window.__navProbe`
// so the test can assert that the behaviour happened, not just that a key was
// pressed.

import "./dev-tauri-stub";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { HistoryPanel } from "./components/HistoryPanel";
import { ShelfPanel } from "./components/ShelfPanel";
import { HighlightsPanel } from "./components/HighlightsPanel";
import { ArticleList } from "./components/ArticleList";
import { VerifyPanel } from "./components/VerifyPanel";
import { Reader } from "./components/Reader";
import { MusicPlayer } from "./components/MusicPlayer";
import type {
  ArticleItem,
  Category,
  ContinueEntry,
  Highlight,
  Settings,
  ShelfEntry,
  SourceSummary,
} from "./api";
import "./styles.css";

const params = new URLSearchParams(location.search);
const FAIL_CONTINUE = params.get("failContinue") === "1";

type NavProbe = {
  selectedSource: string | null;
  openedHistory: string | null;
  openedShelf: string | null;
  openedMark: string | null;
  openedArticle: string | null;
  continued: string | null;
  sibling: string | null;
  queueIndex: number | null;
  verifyExpanded: string | null;
  clearedHistory: number;
};
const probe: NavProbe = {
  selectedSource: null,
  openedHistory: null,
  openedShelf: null,
  openedMark: null,
  openedArticle: null,
  continued: null,
  sibling: null,
  queueIndex: null,
  verifyExpanded: null,
  clearedHistory: 0,
};
(window as unknown as { __navProbe: NavProbe }).__navProbe = probe;

const SOURCES: SourceSummary[] = [
  {
    id: "src-a",
    name: "甲源",
    url: "https://a.example",
    group: "",
    enabled: true,
    favorite: false,
    collection: "演示",
    health: { ok: true, status: "可用", item_count: 3, checked_at: 1, sample: "", stages: [], duration_ms: 12 },
    note: "",
    category_count: 2,
    has_search: false,
    js_enabled: false,
  },
  {
    id: "src-b",
    name: "乙源",
    url: "https://b.example",
    group: "",
    enabled: true,
    favorite: true,
    collection: "演示",
    health: { ok: false, status: "失败", item_count: 0, checked_at: 1, sample: "", stages: [], duration_ms: 40 },
    note: "",
    category_count: 1,
    has_search: false,
    js_enabled: false,
  },
  {
    id: "src-c",
    name: "丙源",
    url: "https://c.example",
    group: "",
    enabled: true,
    favorite: false,
    collection: "演示",
    health: null,
    note: "",
    category_count: 1,
    has_search: false,
    js_enabled: false,
  },
];

const CATEGORIES: Category[] = [
  { name: "全部", url: "/demo/all", row: 0, paged: false },
  { name: "玄幻", url: "/demo/xh", row: 0, paged: false },
];

const ARTICLES: ArticleItem[] = [
  { title: "第一篇", link: "https://demo.local/1", image: "", date: "2024-01-01", kind: "novel" },
  { title: "第二篇", link: "https://demo.local/2", image: "", date: "2024-01-02", kind: "novel" },
];

const SHELF: ShelfEntry[] = [
  {
    id: "s::全部",
    source_id: "s",
    source_name: "甲源",
    category: "全部",
    title: "甲源 · 全部",
    url: "https://demo.local/1",
    kind: "novel",
    added_at: 10,
  },
  {
    id: "s::玄幻",
    source_id: "s",
    source_name: "甲源",
    category: "玄幻",
    title: "甲源 · 玄幻",
    url: "https://demo.local/2",
    kind: "novel",
    added_at: 11,
  },
];

const HISTORY = [
  { id: "1", source_id: "s", title: "读过的第一篇", url: "https://demo.local/1", source_name: "甲源", viewed_at: 1700000000 },
  { id: "2", source_id: "s", title: "读过的第二篇", url: "https://demo.local/2", source_name: "甲源", viewed_at: 1700000100 },
];

const MARKS: Highlight[] = [
  {
    id: "h1",
    url: "https://demo.local/1",
    source_id: "s",
    title: "第一篇",
    source_name: "甲源",
    text: "值得回头再看的一段",
    note: "笔记",
    created_at: 1700000000,
  },
  {
    id: "h2",
    url: "https://demo.local/2",
    source_id: "s",
    title: "第二篇",
    source_name: "甲源",
    text: "另一段被划下来的话",
    note: "",
    created_at: 1700000200,
  },
];

const CONTINUE: ContinueEntry[] = [
  {
    url: "https://demo.local/1",
    title: "读到一半的一篇",
    source_id: "s",
    source_name: "甲源",
    viewed_at: 1700000000,
    progress: 0.5,
  },
];

const SETTINGS: Settings = {
  concurrent_checks: true,
  page_size: 60,
  cache_enabled: false,
  repo_base: "https://www.yck2026.fun",
  user_agent: "",
  reader_font_size: 17,
  reader_line_height: 180,
  reader_font: "",
  reader_theme: "dark",
  reader_width: 0,
  player_volume: 0.8,
  player_rate: 1,
  render_js: false,
};

function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "list_sources":
        return SOURCES;
      case "stats":
        return {
          sources: 3,
          enabled: 3,
          favorites: 1,
          collections: 1,
          history: 2,
          checked: 2,
          working: 1,
        };
      case "get_progress_many":
        return {};
      case "get_progress":
        return 0;
      case "save_progress":
        return null;
      case "continue_reading":
        if (FAIL_CONTINUE) throw new Error("continue_reading 失败");
        return CONTINUE;
      case "list_history":
        return HISTORY;
      case "clear_history":
        probe.clearedHistory += 1;
        return null;
      case "list_shelf":
        return SHELF;
      case "shelf_progress":
        return SHELF.map((entry) => ({ entry, total: 2, finished: 1, partial: 0, note: "" }));
      case "list_highlights":
        return MARKS;
      case "get_settings":
        return SETTINGS;
      case "load_page":
        return { items: ARTICLES, next: null, final_url: String((args.args as { url?: string })?.url ?? "") };
      default:
        return base(cmd, args);
    }
  };
}

installHarness();

type View = "list" | "history" | "shelf" | "highlights" | "verify" | "music" | "reader";

/** Three chapters, so the reader's contents has real entries to jump to. */
const CHAPTERS: ArticleItem[] = [
  { title: "第一章 开端", link: "https://demo.local/c1", image: "", date: "2024-01-01", kind: "novel" },
  { title: "第二章 转折", link: "https://demo.local/c2", image: "", date: "2024-01-02", kind: "novel" },
  { title: "第三章 收束", link: "https://demo.local/c3", image: "", date: "2024-01-03", kind: "novel" },
];

const ARTICLE = {
  title: "第一章 开端",
  final_url: "https://demo.local/c1",
  html: "<p>这一段是为了把阅读器撑开，让正文与目录都能出现。</p>",
  text: "这一段是为了把阅读器撑开，让正文与目录都能出现。",
  media: [],
  audio: [],
};

function Preview() {
  const [view, setView] = useState<View>("list");

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "300px 1fr" }}>
      <Sidebar
        sources={SOURCES}
        selectedId={probe.selectedSource}
        onSelect={(id) => {
          probe.selectedSource = id;
          setView("list");
        }}
        onChanged={() => {}}
        onOpenRepo={() => {}}
        onOpenHistory={() => setView("history")}
        onOpenShelf={() => setView("shelf")}
        onOpenStats={() => {}}
        onOpenHighlights={() => setView("highlights")}
        onOpenVerify={() => setView("verify")}
        onOpenSettings={() => {}}
        shelfCount={SHELF.length}
        highlightCount={MARKS.length}
        stats={{ sources: 3, working: 1, checked: 2 }}
        filterOnlyFavorites={false}
        onToggleFilter={() => {}}
        busy={false}
        onContinue={(entry) => {
          probe.continued = entry.url;
        }}
      />

      <main className="main">
        <div className="main-head">
          <div className="main-title">导航可达性预览</div>
          <span className="spacer" />
          <button data-nav-view="music" onClick={() => setView("music")}>
            音乐队列
          </button>
          <button data-nav-view="reader" onClick={() => setView("reader")}>
            阅读器目录
          </button>
          {probe.selectedSource && <span data-nav-selected>{probe.selectedSource}</span>}
          {probe.openedHistory && <span data-nav-history>{probe.openedHistory}</span>}
          {probe.openedShelf && <span data-nav-shelf>{probe.openedShelf}</span>}
          {probe.openedMark && <span data-nav-mark>{probe.openedMark}</span>}
          {probe.continued && <span data-nav-continue>{probe.continued}</span>}
          {probe.queueIndex !== null && <span data-nav-queue>{probe.queueIndex}</span>}
          {probe.sibling && <span data-nav-sibling>{probe.sibling}</span>}
        </div>

        {view === "list" && (
          <ArticleList
            sourceId={probe.selectedSource ?? "src-a"}
            sourceName="甲源"
            categories={CATEGORIES}
            onOpen={(item) => {
              probe.openedArticle = item.title;
            }}
          />
        )}
        {view === "history" && (
          <HistoryPanel
            onOpen={(h) => {
              probe.openedHistory = h.title;
            }}
            onClose={() => setView("list")}
          />
        )}
        {view === "shelf" && (
          <ShelfPanel
            onOpen={(e) => {
              probe.openedShelf = e.title;
            }}
            onClose={() => setView("list")}
          />
        )}
        {view === "highlights" && (
          <HighlightsPanel
            onOpen={(h) => {
              probe.openedMark = h.id;
            }}
            onClose={() => setView("list")}
          />
        )}
        {view === "verify" && (
          <VerifyPanel
            sources={SOURCES}
            selectedId={null}
            onSelect={() => {}}
            onBack={() => setView("list")}
            onChecked={() => {}}
          />
        )}
        {view === "reader" && (
          <Reader
            loading={false}
            error={null}
            article={ARTICLE}
            sourceName="甲源"
            articleUrl={ARTICLE.final_url}
            siblings={CHAPTERS}
            currentLink={CHAPTERS[0].link}
            currentSourceId="src-a"
            onOpenSibling={(item) => {
              probe.sibling = item.title;
            }}
            settings={SETTINGS}
            onSettingsChange={() => {}}
            onBack={() => setView("list")}
            onOpenExternal={() => {}}
          />
        )}
        {view === "music" && (
          <div className="music" style={{ maxWidth: 560, margin: "0 auto" }}>
            <MusicPlayer
              tracks={[
                { url: "/demo/track-1.mp3", title: "第一首", artist: "甲", duration: 200 },
                { url: "/demo/track-2.mp3", title: "第二首", artist: "乙", duration: 210 },
                { url: "/demo/track-3.mp3", title: "第三首", artist: "丙", duration: 220 },
              ]}
              title="演示歌单"
              onNextTrack={(i) => {
                probe.queueIndex = i;
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);