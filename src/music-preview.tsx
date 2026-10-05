// Development harness for the music player.
//
// Renders MusicPlayer against real audio files so its controls, queue and
// keyboard shortcuts can be exercised in a browser. Opened at
// /music-preview.html while `pnpm dev` is running; never bundled into a release.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./dev-tauri-stub";
import { MusicPlayer, formatTime, isAudioUrl } from "./components/MusicPlayer";
import "./styles.css";

const tracks = [
  // Lyrics for the first two, none for the third, so all three cases are visible.
  { url: "/demo/track-1.wav", title: "第一首 · 测试音", lyricUrl: "/demo/track-1.lrc" },
  { url: "/demo/track-2.wav", title: "第二首 · 测试音", lyricUrl: "/demo/track-2.lrc" },
  { url: "/demo/track-3.wav", title: "第三首 · 测试音" },
];

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

function Preview() {
  return (
    <div className="main" style={{ maxWidth: 720, margin: "40px auto", padding: "0 16px" }}>
      <div className="main-head">
        <div className="main-title">音乐源预览</div>
      </div>
      <div className="main-body">
        <MusicPlayer tracks={tracks} title="演示合集" sleepMinutes={sleepMinutes} />
        <p style={{ color: "var(--text-faint)", fontSize: 12 }}>
          formatTime(90) = {formatTime(90)} · isAudioUrl(/demo/track-1.wav) ={" "}
          {String(isAudioUrl("/demo/track-1.wav"))} · 睡眠定时 =
          {sleepMinutes ? sleepMinutes.join(" / ") : "15 / 30 / 45 / 60 分钟 + 本曲结束"}
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