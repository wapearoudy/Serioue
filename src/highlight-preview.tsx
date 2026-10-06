// Development harness for highlights.
//
// Mounts the real Reader with an article whose sentences are deliberately split
// across inline tags, because that is what source HTML looks like and it is
// the case a naive text match gets wrong.
//
// Opened at /highlight-preview.html while `pnpm dev` is running. Never bundled
// into a release.

import "./dev-tauri-stub";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "./components/Reader";
import { HighlightsPanel } from "./components/HighlightsPanel";
import { api, type ArticleResponse, type Settings } from "./api";
import "./styles.css";

const URL_UNDER_TEST = "https://demo.local/article/1";

const ARTICLE: ArticleResponse = {
  title: "关于阅读器",
  final_url: URL_UNDER_TEST,
  // Each sentence is broken across a <strong> or an <a>, so the passage a
  // reader selects never sits inside a single text node.
  html: `
    <p>阅读器最难的不是把字显示出来，而是让人<strong>愿意一直读下去</strong>。</p>
    <p>行距、字号、版心宽度，任何一项不合适，都会在几页之内把人劝退。</p>
    <p>所以这些数值应该<em>成组调整</em>，而不是一个个孤立地试。</p>
    <p>记住读到哪儿同样重要，<a href="/x">换一台设备</a>、隔一天回来，不用重新找位置。</p>
    <p>最后一段，用来把页面撑高，好让滚动条有东西可滚。</p>
  `,
  text:
    "阅读器最难的不是把字显示出来，而是让人愿意一直读下去。\n行距、字号、版心宽度，任何一项不合适，都会在几页之内把人劝退。",
  media: [],
  audio: [],
};

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

function Preview() {
  const [panel, setPanel] = useState(false);
  const [settings] = useState(SETTINGS);

  if (panel) {
    return (
      <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
        <div className="main" style={{ width: "100%" }}>
          <HighlightsPanel
            onOpen={(h) => console.log("[preview] reopen", h.url)}
            onClose={() => setPanel(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        <Reader
          loading={false}
          error={null}
          article={ARTICLE}
          sourceName="演示源"
          articleUrl={URL_UNDER_TEST}
          currentLink={URL_UNDER_TEST}
          currentSourceId="demo:novel"
          settings={settings}
          onSettingsChange={() => {}}
          onBack={() => {}}
          onOpenExternal={(u) => window.open(u, "_blank")}
        />
        <div style={{ padding: 12, fontSize: 12, color: "var(--text-faint)" }}>
          <button onClick={() => setPanel(true)}>打开划线列表</button>
          <button
            onClick={() => {
              void api.listHighlights().then((l) => console.log("[preview] highlights", l.length));
            }}
          >
            打印当前划线数
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);