// Development harness for the reader as it is used for a video series: the
// real Reader component, a real episode list, and the demo HLS stream from
// `pnpm demo:video`.
//
// Opened at /video-reader-preview.html while `pnpm dev` is running. Never
// bundled into a release.
//
// The reader-preview page re-implements the reader's markup by hand, so it
// cannot catch a change to the real component. This one mounts the real thing.

import "./dev-tauri-stub";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "./components/Reader";
import { api, type ArticleItem, type ArticleResponse, type Settings } from "./api";
import "./styles.css";

const EPISODE_COUNT = 5;

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

const link = (n: number) => `https://demo.local/watch?ep=${n}`;

// `?solo=1` collapses the list to the single episode being watched, which is
// what a standalone video (a trailer, a one-off clip) actually looks like.
const SOLO = new URLSearchParams(location.search).has("solo");
const EPISODES: ArticleItem[] = Array.from(
  { length: SOLO ? 1 : EPISODE_COUNT },
  (_, i) => ({
    title: `第 ${i + 1} 集 · 示例剧集`,
    link: link(i + 1),
    image: "",
    date: `2024-0${(i % 9) + 1}-01`,
    kind: "video",
  }),
);

function Preview() {
  const [url, setUrl] = useState(link(3));
  const [article, setArticle] = useState<ArticleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(SETTINGS);

  // Mirrors how App.tsx loads an entry: a new URL cancels the previous load.
  const [request, setRequest] = useState(0);
  const go = useCallback((next: string) => {
    setUrl(next);
    setLoading(true);
    setError(null);
    setArticle(null);
    setRequest((r) => r + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .loadArticle("demo:series", url)
      .then((a) => {
        if (cancelled) return;
        setArticle(a);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, request]);

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        <Reader
          loading={loading}
          error={error}
          article={article}
          sourceName="示例剧集"
          itemKind="video"
          articleUrl={url}
          siblings={EPISODES}
          currentLink={url}
          onOpenSibling={(item) => go(item.link)}
          onOpenExternal={(u) => window.open(u, "_blank")}
          onBack={() => go(link(1))}
          settings={settings}
          onSettingsChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);