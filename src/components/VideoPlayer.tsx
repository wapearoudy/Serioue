import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

/** Formats the `<video>` element can usually play directly. */
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|mkv)(\?|#|$)/i;
/** Streaming manifests that need a media-source player on Chromium. */
const HLS_EXT = /\.m3u8(\?|#|$)/i;

/** True when a URL points at something the browser can play directly. */
export function isPlayable(url: string): boolean {
  return VIDEO_EXT.test(url) || HLS_EXT.test(url) || url.startsWith("blob:");
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export type Quality = { index: number; label: string };

/** A rendition's vertical size as the shorthand people recognise. */
function levelLabel(width: number, height: number, bitrate: number): string {
  // "720p" is a height, not a width: 1280x720 is 720p, 640x360 is 360p.
  const h = height > 0 ? height : width / 1.78;
  if (h >= 2100) return "4K";
  if (h >= 1500) return "2K";
  if (h > 900) return "1080p";
  if (h > 630) return "720p";
  if (h > 450) return "480p";
  if (h > 0) return "360p";
  return bitrate > 0 ? `${Math.round(bitrate / 1000)}k` : "自动";
}

type Props = {
  src: string;
  poster?: string;
  title?: string;
};

/**
 * Video player with HLS support.
 *
 * Safari plays `.m3u8` natively; Chromium cannot, and `.m3u8` is the most
 * common format in these sources — without this the player was a dead end that
 * only printed "use VLC". hls.js feeds the same `<video>` element through
 * Media Source Extensions, so one element serves both paths.
 *
 * Native controls are kept for transport (play, seek, volume) because they
 * are accessible and behave correctly; the extras a streaming site needs —
 * quality, speed, fullscreen — sit in an overlay.
 */
export function VideoPlayer({ src, poster, title }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);

  const [err, setErr] = useState<string | null>(null);
  const [levels, setLevels] = useState<Quality[]>([]);
  const [level, setLevel] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState<"quality" | "speed" | null>(null);

  const isHls = HLS_EXT.test(src);
  const [nativeHls, setNativeHls] = useState(false);

  // Safari and iOS browsers can play HLS without any library.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    setNativeHls(!!el.canPlayType("application/vnd.apple.mpegurl"));
  }, [src]);

  useEffect(() => {
    const el = video.current;
    if (!el || !isHls || nativeHls) return;

    if (!Hls.isSupported()) {
      setErr("这个系统不支持 HLS 播放。请在系统播放器或 VLC 中打开该链接。");
      return;
    }

    const instance = new Hls({ enableWorker: true, lowLatencyMode: false });
    hls.current = instance;

    instance.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      const parsed = data.levels
        .map((l, i) => ({
          index: i,
          label: levelLabel(l.width ?? 0, l.height ?? 0, l.bitrate ?? 0),
        }))
        .sort((a, b) => a.index - b.index);
      setLevels(parsed);
      setErr(null);
    });

    instance.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      // Auto is -1; report which rendition actually started playing.
      if (data.level >= 0) setLevel(instance.autoLevelEnabled ? -1 : data.level);
    });

    instance.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // One retry usually clears a transient fetch failure.
          instance.startLoad();
          setErr("网络中断，正在重试…");
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          instance.recoverMediaError();
          setErr("解码出错，正在恢复…");
          break;
        default:
          setErr(`视频无法播放：${data.details || "源可能已失效"}`);
          break;
      }
    });

    instance.loadSource(src);
    instance.attachMedia(el);

    return () => {
      instance.destroy();
      hls.current = null;
    };
  }, [src, isHls, nativeHls]);

  // Reset transient UI when the source changes.
  useEffect(() => {
    setErr(null);
    setLevels([]);
    setLevel(-1);
    setPanel(null);
  }, [src]);

  const changeLevel = useCallback((index: number) => {
    const instance = hls.current;
    if (instance) instance.currentLevel = index;
    setLevel(index);
    setPanel(null);
  }, []);

  const changeSpeed = useCallback((rate: number) => {
    const el = video.current;
    if (el) el.playbackRate = rate;
    setSpeed(rate);
    setPanel(null);
  }, []);

  const fullscreen = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      const v = video.current;
      if (!v) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          if (v.paused) v.play().catch(() => {});
          else v.pause();
          break;
        case "ArrowRight":
          v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
          break;
        case "ArrowLeft":
          v.currentTime = Math.max(0, v.currentTime - 10);
          break;
        case "f":
          fullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  return (
    <div className="player-wrap" ref={wrap}>
      <video
        ref={video}
        src={isHls && !nativeHls ? undefined : src}
        poster={poster}
        controls
        playsInline
        onError={() => {
          // hls.js reports its own errors; this only fires for direct files.
          if (!isHls || nativeHls) setErr("视频无法播放：源可能已失效，或该格式不被内置播放器支持。");
        }}
      />

      {levels.length > 0 && (
        <div className="player-extras">
          <button
            className={panel === "quality" ? "on" : ""}
            onClick={() => setPanel((p) => (p === "quality" ? null : "quality"))}
          >
            画质{level === -1 ? " 自动" : ` ${levels.find((l) => l.index === level)?.label ?? ""}`}
          </button>
          <button
            className={panel === "speed" ? "on" : ""}
            onClick={() => setPanel((p) => (p === "speed" ? null : "speed"))}
          >
            {speed}×
          </button>
          <button onClick={fullscreen} title="全屏 (F)">
            ⛶
          </button>
        </div>
      )}

      {panel === "quality" && levels.length > 0 && (
        <div className="player-menu">
          <button
            className={level === -1 ? "on" : ""}
            onClick={() => changeLevel(-1)}
          >
            自动
          </button>
          {[...levels].reverse().map((l) => (
            <button
              key={l.index}
              className={level === l.index ? "on" : ""}
              onClick={() => changeLevel(l.index)}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}

      {panel === "speed" && (
        <div className="player-menu">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? "on" : ""} onClick={() => changeSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
      )}

      {err && (
        <div className={`player-note${err.includes("重试") || err.includes("恢复") ? "" : " bad"}`}>
          {err}
        </div>
      )}

      {title && <div className="player-title">{title}</div>}
    </div>
  );
}