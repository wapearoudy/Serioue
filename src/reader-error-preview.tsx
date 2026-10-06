// Development harness for the error notices.
//
// Mounts the real HistoryPanel, ReaderStatsPanel, ShelfPanel and Reader — the
// four panels that carry an actionable notice — against a backend that can be
// told to fail, so the retry buttons can be exercised in a browser rather than
// reasoned about. Opened at /reader-error-preview.html while `pnpm dev` runs;
// never bundled into a release.
//
//   ?fail=history|stats|shelf|article   which request fails
//   ?failTimes=2                        how many times, counting the first call
//   ?slow=400                           delay every response
//   ?view=history|stats|shelf|reader    which panel to open
//
// `window.__errProbe` counts the calls, which is how a test tells "the retry
// really re-issued the request" from "the button was pressed".

import "./dev-tauri-stub";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HistoryPanel } from "./components/HistoryPanel";
import { ReaderStatsPanel } from "./components/ReaderStatsPanel";
import { ShelfPanel } from "./components/ShelfPanel";
import { Reader } from "./components/Reader";
import type { Settings } from "./api";
import "./styles.css";

const params = new URLSearchParams(location.search);
const FAIL_WHICH = params.get("fail") ?? "";
// Two by default because React's StrictMode mounts effects twice in development:
// a budget of one is spent before the panel has even finished its first paint,
// and the test would be measuring the double mount instead of the retry.
const FAIL_TIMES = Number(params.get("failTimes")) || 2;
const SLOW = Number(params.get("slow")) || 0;

type Probe = { calls: Record<string, number>; failures: number };
const probe: Probe = { calls: {}, failures: 0 };
(window as unknown as { __errProbe: Probe }).__errProbe = probe;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HISTORY = [
  {
    id: "1",
    source_id: "s",
    title: "第一篇",
    url: "https://demo.local/1",
    source_name: "演示源",
    viewed_at: Math.floor(Date.now() / 1000) - 3600,
  },
];

const SHELF = [
  {
    id: "s::全部",
    source_id: "s",
    source_name: "演示源",
    category: "全部",
    title: "演示源 · 全部",
    url: "https://demo.local/1",
    kind: "novel",
    added_at: 1,
  },
];

const SETTINGS: Settings = {
  concurrent_checks: true,
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

const ARTICLE_TEXT = `${"这是一篇用于验证阅读器的演示文章。".repeat(4)}\n第二段同样是为了把页面撑高。`;

function shouldFail(which: string): boolean {
  if (FAIL_WHICH !== which) return false;
  if (probe.failures >= FAIL_TIMES) return false;
  probe.failures += 1;
  return true;
}

function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    probe.calls[cmd] = (probe.calls[cmd] ?? 0) + 1;
    const fail = async (which: string) => {
      if (!shouldFail(which)) return false;
      await wait(SLOW);
      throw new Error(`HTTP 503 · ${which} 暂时不可达`);
    };

    if (cmd === "list_history") {
      if (await fail("history")) return undefined;
      return HISTORY;
    }
    if (cmd === "reading_stats") {
      if (await fail("stats")) return undefined;
      return {
        today: { articles: 2, minutes: 35 },
        week: { articles: 6, minutes: 140 },
        all: { articles: 20, minutes: 600 },
        by_source: [{ source_id: "s", source_name: "演示源", articles: 20 }],
        has_data: true,
      };
    }
    if (cmd === "shelf_progress") {
      if (await fail("shelf")) return undefined;
      return SHELF.map((entry) => ({ entry, total: 2, finished: 1, partial: 0, note: "" }));
    }
    if (cmd === "load_article") {
      if (await fail("article")) return undefined;
      return {
        title: "演示文章",
        final_url: String(args.url ?? "https://demo.local/1"),
        html: `<p>${ARTICLE_TEXT.replace(/\n/g, "</p><p>")}</p>`,
        text: ARTICLE_TEXT,
        media: [],
        audio: [],
      };
    }
    return base(cmd, args);
  };
}

installHarness();

type View = "history" | "stats" | "shelf" | "reader";

function Preview() {
  const [view, setView] = useState<View>(
    (params.get("view") as View | null) ?? "history",
  );
  // The reader's error lives in the parent, exactly as App.tsx holds it: this is
  // the arrangement the closable banner depends on.
  const [articleError, setArticleError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openArticle = useCallback(async () => {
    setLoading(true);
    setArticleError(null);
    try {
      await apiLoad();
    } catch (e) {
      setArticleError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Deliberately call through the installed stub so the counter sees it.
  async function apiLoad() {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Function } })
      .__TAURI_INTERNALS__;
    await internals.invoke("load_article", { id: "s", url: "https://demo.local/1", title: "演示文章" });
  }

  // The reader has no effect that loads the article — the parent does, which is
  // the point — so the harness asks for one itself when that is what is under
  // test.
  useEffect(() => {
    if (view === "reader" && FAIL_WHICH === "article") void openArticle();
  }, [view]);

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        <div className="main-head">
          <div className="main-title">错误条预览</div>
          <span className="spacer" />
          {(["history", "stats", "shelf", "reader"] as View[]).map((v) => (
            <button key={v} className={view === v ? "on" : ""} data-view={v} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
          {view === "reader" && (
            <button data-action="fail-article" onClick={() => void openArticle()}>
              重新请求文章
            </button>
          )}
        </div>

        {view === "history" && (
          <HistoryPanel onOpen={() => {}} onClose={() => setView("history")} />
        )}
        {view === "stats" && <ReaderStatsPanel onClose={() => setView("stats")} />}
        {view === "shelf" && <ShelfPanel onOpen={() => {}} onClose={() => setView("shelf")} />}
        {view === "reader" && (
          <Reader
            loading={loading}
            error={articleError}
            article={null}
            sourceName="演示源"
            articleUrl="https://demo.local/1"
            siblings={[]}
            settings={SETTINGS}
            onSettingsChange={() => {}}
            onErrorClose={() => setArticleError(null)}
            onRetry={() => void openArticle()}
            onBack={() => {}}
            onOpenExternal={() => {}}
          />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
