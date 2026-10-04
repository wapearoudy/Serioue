import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Subtitle } from "./media";

/**
 * hls.js is ~500 kB, which is more than the rest of the app combined.
 *
 * It is imported lazily so a user who only ever reads pays nothing for it, and
 * so the first paint is not waiting on a parser they may never need.
 */
type HlsModule = typeof import("hls.js");
type HlsInstance = import("hls.js").default;

/** Formats the `<video>` element can usually play directly. */
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|mkv)(\?|#|$)/i;
/** Streaming manifests that need a media-source player on Chromium. */
const HLS_EXT = /\.m3u8(\?|#|$)/i;

/** True when a URL points at something the browser can play directly. */
export function isPlayable(url: string): boolean {
  return VIDEO_EXT.test(url) || HLS_EXT.test(url) || url.startsWith("blob:");
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/** `m:ss` for a playback position. */
function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * How the HLS source is played.
 *
 * Deliberately **not** based on `canPlayType("application/vnd.apple.mpegurl")`:
 * Edge answers `"maybe"` on a fresh element while being unable to decode an
 * actual stream, so that probe sends every Windows user to a player that never
 * starts. hls.js is trusted instead because it either works or reports that
 * Media Source Extensions are missing; the element's own `src` is only used
 * when MSE is unavailable, which on Safari is exactly the native path.
 */

/** How often a playback position is written back, in ms. */
const SAVE_EVERY: number = 2000;
/** Below this fraction a video counts as "not started". */
const RESUME_MIN = 0.02;
/** Above this it counts as finished, so it restarts instead of offering resume. */
const RESUME_MAX = 0.98;

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
  /** Key the playback position is remembered against; omit to disable. */
  resumeKey?: string;
  /** Caption tracks declared by the page. */
  subtitles?: Subtitle[];
  /** Title of the next entry in the list, used for the autoplay prompt. */
  nextTitle?: string;
  /** Called when the viewer asks to move on; omit to disable autoplay. */
  onNext?: () => void;
  /** Remembered volume (0-1) and speed, restored on open. */
  volume?: number;
  rate?: number;
  onVolumeChange?: (volume: number) => void;
  onRateChange?: (rate: number) => void;
};

/** Seconds the viewer can take to cancel before the next entry starts. */
const AUTOPLAY_WAIT = 6;

/**
 * Offer to continue into the next entry once a video finishes.
 *
 * A source's listing is usually the episode list, so this is the difference
 * between watching a season one clip at a time and binging it. It prompts
 * rather than jumping, because silently swapping content is hostile.
 */
function useAutoplayPrompt(
  enabled: boolean,
  source: string,
  onNext: (() => void) | undefined,
): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const nextRef = useRef(onNext);
  nextRef.current = onNext;

  useEffect(() => {
    if (!enabled || !nextRef.current) {
      setLeft(null);
      return;
    }
    setLeft(AUTOPLAY_WAIT);
    const tick = setInterval(() => {
      setLeft((n) => {
        if (n === null) return null;
        if (n <= 1) {
          clearInterval(tick);
          nextRef.current?.();
          return null;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
    // `source` re-arms the prompt when a different entry is opened.
  }, [enabled, source]);

  return left;
}

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
export function VideoPlayer({
  src,
  poster,
  title,
  resumeKey,
  subtitles = [],
  nextTitle,
  onNext,
  volume = 0.8,
  rate = 1,
  onVolumeChange,
  onRateChange,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const savedAt = useRef(0);

  const [err, setErr] = useState<string | null>(null);
  const [levels, setLevels] = useState<Quality[]>([]);
  const [level, setLevel] = useState(-1);
  const [speed, setSpeed] = useState(rate);
  // The remembered values arrive as props; mirror them into local state so the
  // controls stay responsive before the settings write comes back.
  useEffect(() => setSpeed(rate), [rate]);
  const [vol, setVol] = useState(volume);
  // Restore the remembered volume once it arrives or changes.
  useEffect(() => setVol(volume), [volume]);
  const [muted, setMuted] = useState(false);
  const [panel, setPanel] = useState<"quality" | "speed" | null>(null);
  /** Seconds the viewer can jump back to, or null when there is nothing to resume. */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  /** Set when a video finishes and there is somewhere to go next. */
  const [finished, setFinished] = useState(false);

  const isHls = HLS_EXT.test(src);
  /** True when this platform can play HLS through Media Source. */
  const [mseAvailable, setMseAvailable] = useState(true);

  useEffect(() => {
    if (!isHls) {
      setMseAvailable(true);
      return;
    }
    let cancelled = false;
    import("hls.js")
      .then((mod: HlsModule) => {
        if (!cancelled) setMseAvailable(mod.default.isSupported());
      })
      .catch(() => {
        if (!cancelled) setMseAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isHls]);

  /** True when hls.js will drive this element through Media Source. */
  const useHls = isHls && mseAvailable;

  useEffect(() => {
    const el = video.current;
    if (!el || !useHls) return;

    let instance: HlsInstance | null = null;
    let cancelled = false;

    void (async () => {
      const { default: Hls } = await import("hls.js");
      // The source may have changed, or the player may have unmounted, while
      // the module was still loading.
      if (cancelled || !video.current) return;

      const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      instance = hls;
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        const parsed = data.levels
          .map((l, i) => ({
            index: i,
            label: levelLabel(l.width ?? 0, l.height ?? 0, l.bitrate ?? 0),
          }))
          .sort((a, b) => a.index - b.index);
        setLevels(parsed);
        setErr(null);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        // Auto is -1; report which rendition actually started playing.
        if (data.level >= 0) setLevel(hls.autoLevelEnabled ? -1 : data.level);
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // One retry usually clears a transient fetch failure.
            hls.startLoad();
            setErr("网络中断，正在重试…");
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            setErr("解码出错，正在恢复…");
            break;
          default:
            setErr(`视频无法播放：${data.details || "源可能已失效"}`);
            break;
        }
      });

      hls.loadSource(src);
      hls.attachMedia(el);
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      hlsRef.current = null;
    };
  }, [src, useHls]);

  // Reset transient UI when the source changes.
  useEffect(() => {
    setErr(null);
    setLevels([]);
    setLevel(-1);
    setPanel(null);
    setResumeAt(null);
    setFinished(false);
  }, [src]);

  const countdown = useAutoplayPrompt(finished, src, onNext);

  /** Write the position back, throttled so scrubbing does not hammer the disk. */
  const save = useCallback(
    (force: boolean) => {
      const el = video.current;
      if (!el || !resumeKey) return;
      const duration = el.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const now = Date.now();
      if (!force && now - savedAt.current < SAVE_EVERY) return;
      savedAt.current = now;
      api.saveProgress(resumeKey, el.currentTime / duration).catch(() => {
        /* losing a position is not worth interrupting playback */
      });
    },
    [resumeKey],
  );

  // When a video ends, offer the next entry if there is one; otherwise just
  // make sure the position is stored.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const onEnded = () => {
      if (onNext && nextTitle) setFinished(true);
      else save(true);
    };
    el.addEventListener("ended", onEnded);
    return () => el.removeEventListener("ended", onEnded);
  }, [onNext, nextTitle, save]);

  // Save on the way out, including when the component unmounts mid-playback.
  useEffect(() => {
    const el = video.current;
    if (!el || !resumeKey) return;
    const onPause = () => save(true);
    const onRateChange = () => save(true);
    el.addEventListener("pause", onPause);
    el.addEventListener("ratechange", onRateChange);
    return () => {
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ratechange", onRateChange);
      save(true);
    };
  }, [save, resumeKey]);

  /**
   * Offer to continue from where the viewer stopped.
   *
   * Runs on `loadedmetadata`, once the duration is known. A finished video is
   * not offered as resumable, so a rewatch always starts at the top.
   */
  const onLoadedMetadata = useCallback(() => {
    const el = video.current;
    if (!el || !resumeKey || !Number.isFinite(el.duration) || el.duration <= 0) return;
    api
      .getProgress(resumeKey)
      .then((ratio) => {
        if (cancelled.current) return;
        if (!Number.isFinite(ratio) || ratio <= RESUME_MIN || ratio >= RESUME_MAX) return;
        setResumeAt(el.duration * ratio);
      })
      .catch(() => {
        /* no stored position */
      });
  }, [resumeKey]);

  const cancelled = useRef(false);
  useEffect(() => {
    // Reset on every mount: React's StrictMode runs mount → unmount → mount in
    // development, and a flag that is only ever set would latch true and
    // silently disable the resume for the rest of the session.
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const continueWatching = useCallback(() => {
    const el = video.current;
    if (el && resumeAt !== null) {
      el.currentTime = resumeAt;
      el.play().catch(() => setErr("无法自动播放，请点一下播放按钮。"));
    }
    setResumeAt(null);
  }, [resumeAt]);

  const startOver = useCallback(() => {
    const el = video.current;
    if (el) {
      el.currentTime = 0;
      // Drop the stored position so the next visit does not offer to resume.
      if (resumeKey) api.saveProgress(resumeKey, 0).catch(() => {});
    }
    setResumeAt(null);
    setFinished(false);
  }, [resumeKey]);

  const changeLevel = useCallback((index: number) => {
    const instance = hlsRef.current;
    if (instance) instance.currentLevel = index;
    setLevel(index);
    setPanel(null);
  }, []);

  const changeSpeed = useCallback(
    (next: number) => {
      const el = video.current;
      if (el) el.playbackRate = next;
      setSpeed(next);
      setPanel(null);
      onRateChange?.(next);
    },
    [onRateChange],
  );

  // Remembered volume: applied on open and whenever it changes. Writing it back
  // through a callback rather than persisting from here keeps this component
  // free of the settings store.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.volume = vol;
    el.muted = muted;
  }, [vol, muted]);

  const changeVolume = useCallback(
    (next: number) => {
      setMuted(false);
      setVol(next);
      onVolumeChange?.(next);
    },
    [onVolumeChange],
  );

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
        src={useHls ? undefined : src}
        poster={poster}
        controls
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={() => save(false)}
        onEnded={() => {
          if (!(onNext && nextTitle)) setFinished(false);
        }}
        onError={() => {
          // hls.js reports its own errors; this only fires for direct files.
          if (!useHls) setErr("视频无法播放：源可能已失效，或该格式不被内置播放器支持。");
        }}
      >
        {subtitles.map((t) => (
          <track
            key={t.src}
            kind="subtitles"
            src={t.src}
            srcLang={t.lang || undefined}
            label={t.label}
            default={t.isDefault}
          />
        ))}
      </video>

      {countdown !== null && (
        <div className="player-resume">
          <span className="player-resume-text">
            {countdown} 秒后播放：{nextTitle}
          </span>
          <button className="primary" onClick={() => onNext?.()}>
            立即播放
          </button>
          <button
            onClick={() => {
              setFinished(false);
              setPanel(null);
            }}
          >
            取消
          </button>
        </div>
      )}

      {resumeAt !== null && (
        <div className="player-resume">
          <span className="player-resume-text">
            上次看到 {formatSeconds(resumeAt)}
          </span>
          <button className="primary" onClick={continueWatching}>
            继续播放
          </button>
          <button onClick={startOver}>从头开始</button>
        </div>
      )}

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

      <div className="player-extras">
        <button onClick={() => setMuted((m) => !m)} title={muted ? "取消静音" : "静音"}>
          {muted ? "🔇" : "🔊"}
        </button>
        <input
          className="player-volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : vol}
          onChange={(e) => changeVolume(Number(e.target.value))}
          aria-label="音量"
          style={{ "--pct": `${(muted ? 0 : vol) * 100}%` } as React.CSSProperties}
        />
      </div>

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