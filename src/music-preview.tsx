// Development harness for the music player.
//
// Renders MusicPlayer against real audio files so its controls, queue and
// keyboard shortcuts can be exercised in a browser. Opened at
// /music-preview.html while `pnpm dev` is running; never bundled into a release.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./dev-tauri-stub";
import { MusicPlayer, formatTime, isAudioUrl } from "./components/MusicPlayer";
import "./styles.css";

const BASE_TRACKS = [
  // Lyrics for the first two, none for the third, so all three cases are visible.
  // The third carries no artist and no length on purpose: the queue has to show
  // an honest `—` instead of an empty cell.
  {
    url: "/demo/track-1.wav",
    title: "第一首 · 测试音",
    artist: "演示歌手 · 甲",
    duration: 8,
    lyricUrl: "/demo/track-1.lrc",
  },
  {
    url: "/demo/track-2.wav",
    title: "第二首 · 测试音",
    artist: "演示歌手 · 乙",
    duration: 2,
    lyricUrl: "/demo/track-2.lrc",
  },
  { url: "/demo/track-3.wav", title: "第三首 · 测试音" },
];

/**
 * A different audio URL for the first track: `?src=http://127.0.0.1:PORT/long.wav`.
 *
 * The demo fixtures are deliberately tiny (1–8 seconds), which is right for
 * exercising controls but useless for anything measured in seconds of listening:
 * a resume threshold of ten seconds can never be crossed on an eight-second
 * file. This lets a browser test supply its own longer audio — served from its
 * own temporary server — instead of every such test having to change the shared
 * fixtures, which the lyric and queue legs depend on.
 */
const srcParam = new URLSearchParams(window.location.search).get("src");
const tracks = srcParam
  ? [
      {
        url: srcParam,
        title: "长音轨 · 断点续听",
        artist: "测试用",
        lyricUrl: "/demo/track-1.lrc",
      },
      BASE_TRACKS[1],
      BASE_TRACKS[2],
    ]
  : BASE_TRACKS;

/**
 * A whole list of tracks: `?tracks=[{"url":"…","title":"坏的一首"}, …]`.
 *
 * Anything that needs a particular queue shape — a broken track in the middle so
 * 「跳过这一首」 can be exercised, a dead track *last* so the button has nothing
 * to skip to — needs control over more than the first entry. Encoded as JSON so
 * it stays one query parameter.
 */
const tracksParam = new URLSearchParams(window.location.search).get("tracks");
let list = tracks;
if (tracksParam) {
  try {
    const parsed: unknown = JSON.parse(tracksParam);
    if (Array.isArray(parsed) && parsed.length > 0) {
      list = parsed as typeof BASE_TRACKS;
    }
  } catch {
    // A malformed parameter is the test's mistake, not the page's: fall back to
    // the normal list rather than rendering nothing.
  }
}

/**
 * Sleep-timer options, overridable so a browser test does not have to wait a
 * quarter of an hour: `?sleepMinutes=0.1,0.25` offers 6 s and 15 s instead of
 * 15/30/45/60. Without the parameter the page shows the real options.
 */
const sleepParam = new URLSearchParams(window.location.search).get("sleepMinutes");
const sleepMinutes = sleepParam
  ? sleepParam
      .split(",")
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0)
  : undefined;

/**
 * `?rerender=1` re-renders this page ten times a second and hands the player a
 * freshly built array each time — the shape `reader-nav-preview` produces
 * already, and the shape that once froze `ArticleList` into a 100% CPU loop.
 * With it on, a queue that is written back on every render, and stored on every
 * state change, is visible immediately rather than in theory.
 */
const RERENDER = new URLSearchParams(window.location.search).get("rerender") === "1";

function Preview() {
  const [renders, setRenders] = useState(0);

  useEffect(() => {
    if (!RERENDER) return;
    const id = window.setInterval(() => setRenders((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, []);

  // Rebuilt on purpose when asked to: a new array identity every render.
  const shown = RERENDER ? list.map((t) => ({ ...t })) : list;

  return (
    <div
      className="main"
      data-rerenders={renders}
      style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px" }}
    >
      <div className="main-head">
        <div className="main-title">音乐源预览</div>
      </div>
      <div className="main-body">
        <MusicPlayer
          tracks={shown}
          title="演示合集"
          sleepMinutes={sleepMinutes}
          sourceId="demo:album"
        />
        <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
          formatTime(90) = {formatTime(90)} · isAudioUrl(/demo/track-1.wav) ={" "}
          {String(isAudioUrl("/demo/track-1.wav"))} · 睡眠定时 =
          {sleepMinutes ? sleepMinutes.join(" / ") : "15 / 30 / 45 / 60 分钟 + 本曲结束"}
          {RERENDER ? ` · 重渲染 ${renders} 次` : ""}
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);