import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Subtitle } from "./media";
import {
  clearQualityMemory,
  qualityMemoryKey,
  readQualityMemory,
  writeQualityMemory,
} from "./videoQuality";

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
 * How long the viewer may leave the pointer alone before the controls fade out
 * in fullscreen. Three seconds is what a touch player waits; shorter and the
 * bar blinks during every reach for the volume slider.
 *
 * Deliberately not exported: a non-component export is enough to break Fast
 * Refresh for the whole module, and nothing outside the player needs this.
 */
const UI_IDLE_MS = 3000;

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
 * Native controls are **not** used. Chromium's control bar takes over the
 * gestures a video site needs: a single click anywhere on the picture toggles
 * playback, and a double click puts the `<video>` element itself into
 * fullscreen instead of the player wrapper — and `preventDefault()` cannot stop
 * either. Since this player owns its transport (play, seek, volume) and its
 * extras (quality, speed, picture-in-picture, fullscreen), a single click can be
 * left alone and a double click can target the wrapper.
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

  /**
   * Fullscreen feel.
   *
   * `playing` and `isFullscreen` come from the element and the document rather
   * than from a click handler, because playback can start without a click (the
   * autoplay prompt, resuming a stored position) and fullscreen can end with the
   * Escape key. `uiHidden` is the only thing the controls actually read.
   */
  const [playing, setPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  /** Bumped by any interaction, to restart the idle countdown. */
  const [wake, setWake] = useState(0);
  /** True while the element is starved for data. */
  const [buffering, setBuffering] = useState(false);
  /** How much of the stream is already downloaded, 0-100. */
  const [bufferedPct, setBufferedPct] = useState(0);
  /** The level restored from memory for this entry, or null. */
  const [remembered, setRemembered] = useState<number | null>(null);
  /** Playhead and runtime, for the seek bar. */
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /**
   * Picture-in-picture. The native bar used to provide it; this bar replaces it,
   * so the capability has to come back explicitly or it would simply be lost.
   */
  const [pipActive, setPipActive] = useState(false);
  // Asked of the document, not of the element: on the first render the ref is
  // still null, and a button that only appears on some later re-render is a
  // button that is sometimes missing.
  const pipAvailable =
    typeof document !== "undefined" && document.pictureInPictureEnabled === true;

  /** Which entry the quality memory belongs to. */
  const memKey = qualityMemoryKey(resumeKey, src);
  // Read from inside the hls.js callbacks, which outlive any one render.
  const memKeyRef = useRef(memKey);
  memKeyRef.current = memKey;

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

        // Restore the level this entry was last watched at. A memory that points
        // at a rendition this stream does not have is ignored rather than
        // applied, so a re-encoded entry falls back to 自动 instead of stalling.
        const stored = readQualityMemory(memKeyRef.current);
        if (stored === null) {
          setRemembered(null);
          return;
        }
        const usable = stored === -1 || parsed.some((l) => l.index === stored);
        if (!usable) {
          setRemembered(null);
          return;
        }
        hls.currentLevel = stored;
        setLevel(stored);
        setRemembered(stored);
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
    setBuffering(false);
    setBufferedPct(0);
    // -1 here is the "no choice remembered yet" marker, not a remembered 自动.
    setRemembered(readQualityMemory(memKeyRef.current));
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
    // Remembered per entry: the whole point is that opening this episode again
    // does not silently drop back to 自动.
    writeQualityMemory(memKeyRef.current, index);
    setRemembered(index);
  }, []);

  /** Forget this entry's quality choice, so the next open starts at 自动. */
  const forgetLevel = useCallback(() => {
    clearQualityMemory(memKeyRef.current);
    const instance = hlsRef.current;
    if (instance) instance.currentLevel = -1;
    setLevel(-1);
    setRemembered(null);
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

  const togglePlayback = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setErr("无法自动播放，请点一下播放按钮。"));
    else el.pause();
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const el = video.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration, seconds));
    setTime(el.currentTime);
  }, []);

  const togglePip = useCallback(() => {
    const el = video.current;
    if (!el || typeof el.requestPictureInPicture !== "function") return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    // hls.js drives the element through Media Source; a picture-in-picture
    // window may or may not accept it depending on the platform, so a refusal
    // is reported rather than swallowed.
    el.requestPictureInPicture().catch(() => setErr("画中画不可用：浏览器拒绝了该请求。"));
  }, []);

  // Fullscreen is a document-level state: Escape leaves it without going through
  // the button, and `fullscreenchange` is the only place that is true.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // -- buffering --------------------------------------------------------------
  // "缓冲中…" with a percentage, from the element's own buffered ranges. A bare
  // spinner cannot be told apart from a stall; 缓冲中… 63% can.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const readPct = () => {
      const duration = el.duration;
      if (!Number.isFinite(duration) || duration <= 0) return 0;
      const ranges = el.buffered;
      // The range containing the playhead is the one that matters; for a seek
      // past the buffered window the furthest end is the honest answer.
      let end = 0;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= el.currentTime + 0.25) end = Math.max(end, ranges.end(i));
      }
      if (end === 0 && ranges.length > 0) end = ranges.end(ranges.length - 1);
      return Math.max(0, Math.min(100, (end / duration) * 100));
    };
    const onProgress = () => setBufferedPct(readPct());
    const onWaiting = () => {
      setBufferedPct(readPct());
      setBuffering(true);
    };
    const onPlaying = () => {
      setBufferedPct(readPct());
      setBuffering(false);
    };
    const onCanPlay = () => setBuffering(false);
    el.addEventListener("progress", onProgress);
    el.addEventListener("timeupdate", onProgress);
    el.addEventListener("loadedmetadata", onProgress);
    el.addEventListener("durationchange", onProgress);
    el.addEventListener("seeked", onProgress);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("stalled", onWaiting);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("canplaythrough", onCanPlay);
    el.addEventListener("seeking", onWaiting);
    return () => {
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("timeupdate", onProgress);
      el.removeEventListener("loadedmetadata", onProgress);
      el.removeEventListener("durationchange", onProgress);
      el.removeEventListener("seeked", onProgress);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("stalled", onWaiting);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("canplaythrough", onCanPlay);
      el.removeEventListener("seeking", onWaiting);
    };
  }, []);

  // -- auto-hiding controls ---------------------------------------------------
  // Playhead for the fullscreen transport. `timeupdate` is ~4 Hz, which is plenty
  // for a seek bar that the viewer drags rather than watches.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    const onPip = () => setPipActive(true);
    const onPipLeave = () => setPipActive(false);
    el.addEventListener("enterpictureinpicture", onPip);
    el.addEventListener("leavepictureinpicture", onPipLeave);
    onMeta();
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("seeked", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("enterpictureinpicture", onPip);
      el.removeEventListener("leavepictureinpicture", onPipLeave);
    };
  }, []);

  // Playing state, read from the element: the autoplay prompt and resume both
  // start playback without a click on the transport.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    onPlay();
    onPause();
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
    };
  }, []);

  // Any pointer, touch or key activity brings the controls straight back.
  useEffect(() => {
    const wake = () => setWake((n) => n + 1);
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointermove", wake, options);
    window.addEventListener("pointerdown", wake, options);
    window.addEventListener("touchstart", wake, options);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  /**
   * The controls may only fade while nothing needs reading: a panel is open, a
   * resume prompt is up, playback has stopped, or the video is not fullscreen.
   * Paused always shows them — hiding the only way to press play is a trap.
   */
  const canHide =
    isFullscreen &&
    playing &&
    panel === null &&
    countdown === null &&
    resumeAt === null &&
    !finished &&
    !err;

  useEffect(() => {
    setUiHidden(false);
    if (!canHide) return;
    const timer = window.setTimeout(() => setUiHidden(true), UI_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [canHide, wake]);

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

  // In fullscreen the extras float over the picture: sitting in a row under a
  // full-height video would put them off screen. The stylesheet's 62vh cap is a
  // page layout, not something to stare at in fullscreen, so the element's own
  // height is lifted here.
  const fsBar = (bottom: number): React.CSSProperties =>
    isFullscreen
      ? {
          position: "absolute",
          left: 12,
          right: 12,
          bottom,
          marginTop: 0,
          padding: "4px 8px",
          borderRadius: 8,
          background: "rgba(0, 0, 0, 0.55)",
        }
      : {};

  return (
    <div
      className="player-wrap"
      ref={wrap}
      data-fullscreen={isFullscreen ? "1" : "0"}
      onDoubleClick={(e) => {
        // A double click on our own buttons is a button click, not a request to
        // go fullscreen.
        if ((e.target as HTMLElement).closest(".player-controls")) return;
        // With the native controls up, Chromium turns a double click on the
        // picture into the *video element's* own fullscreen — which would hide
        // our bar, its auto-hide and its quality menu behind a UA screen. This
        // player has to be the one that goes fullscreen, so the browser's own
        // default is cancelled.
        e.preventDefault();
        fullscreen();
      }}
    >
      {/*
        The browser's own controls are not used.

        Two of this task's requirements are impossible with them: a click
        anywhere on the picture toggles playback (so a click interrupts the
        video), and a double click is taken by the UA as the *video element's*
        own fullscreen, which `preventDefault` does not cancel. Both behaviours
        belong to the element, not to any listener, so the only way to have this
        player be the one that behaves is to give it a bar of its own — which is
        also what every streaming site does.
      */}
      <video
        ref={video}
        src={useHls ? undefined : src}
        poster={poster}
        controls={false}
        playsInline
        style={isFullscreen ? { maxHeight: "100vh" } : undefined}
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

      {buffering && (
        <div
          className="player-buffering"
          data-buffered-pct={Math.round(bufferedPct)}
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "4px 12px",
            borderRadius: 999,
            fontSize: 12,
            color: "#fff",
            background: "rgba(0, 0, 0, 0.65)",
            pointerEvents: "none",
          }}
        >
          缓冲中… {Math.round(bufferedPct)}%
        </div>
      )}

      {countdown !== null && (
        <div
          className="player-resume"
          style={{
            // The stylesheet pins this prompt near the bottom of the wrapper,
            // which is where the control bars now live; anchored to the top of
            // the picture it stays clear of them in both modes.
            top: 12,
            bottom: "auto",
            borderRadius: 8,
          }}
        >
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
        <div
          className="player-resume"
          style={{ top: 12, bottom: "auto", borderRadius: 8 }}
        >
          <span className="player-resume-text">
            上次看到 {formatSeconds(resumeAt)}
          </span>
          <button className="primary" onClick={continueWatching}>
            继续播放
          </button>
          <button onClick={startOver}>从头开始</button>
        </div>
      )}

      {/*
        One group, one opacity: the extras, the menus, the title and the error
        note all fade together, because a bar that hides while its own menu is
        open is just a broken control.
      */}
      <div
        className="player-controls"
        data-controls="1"
        data-hidden={uiHidden ? "1" : "0"}
        style={{
          opacity: uiHidden ? 0 : 1,
          transition: "opacity 240ms ease",
          pointerEvents: uiHidden ? "none" : "auto",
        }}
      >
        {levels.length > 0 && (
          <div className="player-extras" style={fsBar(46)}>
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
            <button onClick={fullscreen} title="全屏 (F) · 双击画面也可切换">
              ⛶
            </button>
          </div>
        )}

        <div className="player-extras" style={fsBar(6)}>
          {/*
            The transport. Present in every mode, because the native bar is not:
            a picture click stays inert and a double click stays ours.
          */}
          <button
            data-play-toggle="1"
            onClick={togglePlayback}
            title={playing ? "暂停 (空格)" : "播放 (空格)"}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <button onClick={() => seekBy(time - 10)} title="后退 10 秒 (←)">
            ⟲
          </button>
          <input
            className="player-seek"
            type="range"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.5}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seekBy(Number(e.target.value))}
            aria-label="播放进度"
            style={{
              flex: 1,
              minWidth: 80,
              WebkitAppearance: "none",
              appearance: "none",
              height: 4,
              borderRadius: 2,
              background: isFullscreen ? "rgba(255,255,255,0.4)" : "var(--border)",
            }}
          />
          <span data-time="1" style={{ fontSize: 12, minWidth: 78, textAlign: "right" }}>
            {formatSeconds(time)} / {formatSeconds(duration)}
          </span>
          {pipAvailable && (
            <button
              data-pip="1"
              onClick={togglePip}
              title={pipActive ? "退出画中画" : "画中画"}
            >
              {pipActive ? "⤢" : "⤡"}
            </button>
          )}
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
          <div className="player-menu" data-quality-menu="1">
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
            {/* The remembered choice is visible, and clearable: a setting nobody
                can undo is a setting nobody should have. */}
            <div
              data-remembered={remembered === null ? "none" : String(remembered)}
              style={{
                marginTop: 4,
                padding: "4px 10px 0",
                borderTop: "1px solid var(--border)",
                fontSize: 11,
                color: "var(--text-faint)",
              }}
            >
              已记住：
              {remembered === null
                ? "无"
                : remembered === -1
                  ? "自动"
                  : (levels.find((l) => l.index === remembered)?.label ?? String(remembered))}
            </div>
            <button
              data-quality-clear="1"
              disabled={remembered === null}
              onClick={forgetLevel}
            >
              清除本条画质记忆
            </button>
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

        {title && !isFullscreen && <div className="player-title">{title}</div>}
      </div>
    </div>
  );
}