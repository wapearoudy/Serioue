import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Subtitle } from "./media";
import {
  clearQualityMemory,
  qualityMemoryKey,
  readQualityMemory,
  writeQualityMemory,
} from "./videoQuality";
import {
  readShortcutsEnabled,
  readSubtitleStyle,
  subtitleStyleKey,
  writeShortcutsEnabled,
  writeSubtitleStyle,
  type SubtitleSize,
  type SubtitlePosition,
  type SubtitleStyle,
} from "./videoSubtitleStyle";

/**
 * The shortcut table, shown in the player itself.
 *
 * A shortcut nobody can find is a shortcut nobody uses, and it is worse than
 * none when the viewer does discover it by accident.
 */
const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "空格 / K", what: "播放 · 暂停" },
  { keys: "← / →", what: "后退 / 前进 10 秒" },
  { keys: "↑ / ↓", what: "音量 ±5%" },
  { keys: "F", what: "全屏 / 退出全屏" },
  { keys: "M", what: "静音 / 取消静音" },
  { keys: "C", what: "字幕开关" },
  { keys: "0–9", what: "跳到 0% – 90%" },
  { keys: "Esc", what: "退出全屏" },
];

/** Subtitle sizes as pixels, so the caption is legible on any window size. */
const SUBTITLE_SIZE_PX: Record<SubtitleSize, number> = {
  small: 16,
  medium: 22,
  large: 30,
  huge: 38,
};

const SUBTITLE_SIZE_OPTIONS: [SubtitleSize, string][] = [
  ["small", "小"],
  ["medium", "中"],
  ["large", "大"],
  ["huge", "特大"],
];

const SUBTITLE_POSITION_OPTIONS: [SubtitlePosition, string][] = [
  ["top", "顶部"],
  ["middle", "中部"],
  ["bottom", "底部"],
];

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
  /**
   * Identity of the source, used to remember subtitle appearance per source.
   * Defaults to the resume key, then the stream URL.
   */
  sourceId?: string;
};

/** How far a seek key press moves, and how much a volume key press changes. */
const SEEK_STEP_SECONDS = 10;
const VOLUME_STEP = 0.05;

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
  sourceId,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const savedAt = useRef(0);
  /**
   * The control bar, and where the pointer last was.
   *
   * The idle countdown cannot run on events alone: a hand resting on the bar to
   * fine-tune the playhead produces no event at all, so a timer that only
   * restarts on activity fades the bar out from under the hand that is using
   * it. Before hiding anything, the timer asks this pair where the pointer is.
   */
  const controls = useRef<HTMLDivElement>(null);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);

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
  const [panel, setPanel] = useState<"quality" | "speed" | "subtitles" | "shortcuts" | null>(null);
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

  /* -- captions ----------------------------------------------------------- */

  /**
   * Captions are drawn by the player, not by the browser.
   *
   * A `<track>` cue box cannot be moved: `::cue` accepts almost no geometry, so
   * "put the subtitles at the top" is not expressible through the native
   * renderer on any engine. Owning the overlay is what makes the position — and
   * the font size, and the plate behind the text — real settings rather than a
   * promise. The browser's own rendering is therefore switched off by setting
   * every track to `hidden`, which still parses the cues and keeps `activeCues`
   * available for the mirror below.
   */
  const captionKey = subtitleStyleKey(sourceId ?? resumeKey ?? src);
  const [style, setStyle] = useState<SubtitleStyle>(() => readSubtitleStyle(captionKey));
  const [captionsOn, setCaptionsOn] = useState(true);
  /** The line the browser says is current, or null between cues. */
  const [cue, setCue] = useState<string | null>(null);

  // Reload the style when the source changes: one film's big captions must not
  // become the next one's.
  useEffect(() => {
    setStyle(readSubtitleStyle(captionKey));
    setCaptionsOn(true);
    setCue(null);
  }, [captionKey]);

  const applyStyle = useCallback((next: SubtitleStyle) => {
    setStyle(next);
    writeSubtitleStyle(captionKey, next);
  }, [captionKey]);

  /* -- keyboard shortcuts -------------------------------------------------- */

  /** On by default; a viewer who turns it off means it for every source. */
  const [shortcutsOn, setShortcutsOn] = useState(() => readShortcutsEnabled());
  /**
   * What was just done, for a screen reader and for the eye.
   *
   * `seq` is part of the message because repeating the *same* text is not an
   * announcement: without it, holding `→` twice would be read once.
   */
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number } | null>(null);
  const announce = useCallback((text: string) => {
    setAnnouncement((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

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
  // The pointer's position is kept as well as the wake, because "is the hand
  // on the bar right now" is a question no event can answer later.
  useEffect(() => {
    const wake = () => setWake((n) => n + 1);
    const track = (e: PointerEvent) => {
      pointerAt.current = { x: e.clientX, y: e.clientY };
      wake();
    };
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointermove", track, options);
    window.addEventListener("pointerdown", track, options);
    window.addEventListener("touchstart", wake, options);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", track);
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
    const timer = window.setTimeout(() => {
      /**
       * A pointer parked on the bar is using the bar.
       *
       * Silent, still, and exactly the state the bar must survive — so the
       * position is hit-tested here rather than waited on. Finding the pointer
       * on the bar re-arms the countdown instead of hiding; the moment the
       * pointer leaves, the next tick hides as usual, because from then on the
       * hit test lands on the picture. Deliberately still a countdown: the bar
       * is not pinned, it is simply not hidden out from under a hand.
       */
      const at = pointerAt.current;
      const under = at ? document.elementFromPoint(at.x, at.y) : null;
      const bar = controls.current;
      if (bar && under && bar.contains(under)) {
        setWake((n) => n + 1);
        return;
      }
      setUiHidden(true);
    }, UI_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [canHide, wake]);

  // -- captions --------------------------------------------------------------
  // Take the browser's rendering away and mirror the current cue ourselves.
  useEffect(() => {
    const el = video.current;
    if (!el) return;

    const read = () => {
      let text: string | null = null;
      for (let i = 0; i < el.textTracks.length; i++) {
        const active = el.textTracks[i].activeCues;
        if (active && active.length > 0) {
          // `VTTCue` carries the text; a plain `TextTrackCue` does not, and
          // casting is the honest way to say so.
          const cue = active[active.length - 1] as VTTCue;
          text = cue.text ?? "";
          break;
        }
      }
      setCue((prev) => (prev === text ? prev : text));
    };

    // `hidden` rather than `disabled`: the cues still load and stay queryable.
    for (let i = 0; i < el.textTracks.length; i++) {
      el.textTracks[i].mode = "hidden";
    }

    el.addEventListener("timeupdate", read);
    el.addEventListener("seeked", read);
    el.addEventListener("loadedmetadata", read);
    // `cuechange` fires on the track, not on the element.
    for (let i = 0; i < el.textTracks.length; i++) {
      el.textTracks[i].addEventListener("cuechange", read);
    }
    read();
    return () => {
      el.removeEventListener("timeupdate", read);
      el.removeEventListener("seeked", read);
      el.removeEventListener("loadedmetadata", read);
      for (let i = 0; i < el.textTracks.length; i++) {
        el.textTracks[i].removeEventListener("cuechange", read);
      }
    };
  }, [subtitles]);

  // -- keyboard shortcuts ---------------------------------------------------
  useEffect(() => {
    /**
     * True when the key belongs to whoever is typing.
     *
     * Not a nicety: a viewer renaming a bookmark, or typing a number into a
     * search box, must not have the film jump or pause under them.
     *
     * A slider is the exception, and it is the one that matters most: nothing
     * can be typed into it, and a drag leaves the focus on it, so excluding it
     * handed the arrow keys to the range's own `step` — half a second a press,
     * through `onChange`, while this handler returned early. Dragging the
     * playhead would quietly turn ← and → into a 0.5 s nudge. They have to
     * mean ten seconds everywhere in this player.
     */
    const isTypingTarget = (el: Element | null): boolean => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT") return true;
      if (tag === "INPUT") return (el as HTMLInputElement).type !== "range";
      return (el as HTMLElement).isContentEditable === true;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!shortcutsOn) return;
      // A modified key belongs to the browser or the OS.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      // Escape is the browser's to handle: it is how fullscreen is left, and
      // swallowing it here would trap the viewer in fullscreen.
      if (e.key === "Escape") return;
      // While a menu is open the letter keys belong to the menu — and the space
      // bar too, because that is how a menu is walked.
      if (panel !== null) return;

      const v = video.current;
      if (!v) return;
      const duration = Number.isFinite(v.duration) ? v.duration : 0;

      switch (e.key) {
        case " ":
        case "Spacebar":
        case "k":
        case "K": {
          e.preventDefault();
          if (v.paused) {
            v.play().catch(() => {});
            announce("播放");
          } else {
            v.pause();
            announce("暂停");
          }
          break;
        }
        case "ArrowRight":
        case "ArrowLeft": {
          e.preventDefault();
          const forward = e.key === "ArrowRight";
          // Each press adds to where the playhead already is, so holding the
          // key accumulates rather than jumping back and forth.
          const next = Math.max(
            0,
            Math.min(
              duration || v.currentTime,
              v.currentTime + (forward ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS),
            ),
          );
          v.currentTime = next;
          setTime(next);
          announce(`${forward ? "快进" : "快退"} 10 秒 · ${formatSeconds(next)}`);
          break;
        }
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const up = e.key === "ArrowUp";
          const next = Math.max(0, Math.min(1, v.volume + (up ? VOLUME_STEP : -VOLUME_STEP)));
          changeVolume(next);
          announce(`音量 ${Math.round(next * 100)}%`);
          break;
        }
        case "f":
        case "F": {
          e.preventDefault();
          const wasFullscreen = !!document.fullscreenElement;
          fullscreen();
          announce(wasFullscreen ? "退出全屏" : "全屏");
          break;
        }
        case "m":
        case "M": {
          e.preventDefault();
          setMuted((was) => {
            announce(was ? "取消静音" : "静音");
            return !was;
          });
          break;
        }
        case "c":
        case "C": {
          // Nothing to switch if the page declared no captions.
          if (subtitles.length === 0) return;
          e.preventDefault();
          setCaptionsOn((was) => {
            announce(was ? "字幕已关闭" : "字幕已开启");
            return !was;
          });
          break;
        }
        default: {
          // 0–9 seek to 0%–90%. Digits typed into a box were filtered out above.
          if (!/^[0-9]$/.test(e.key)) return;
          if (duration <= 0) return;
          e.preventDefault();
          const percent = Number(e.key) * 10;
          const next = (duration * percent) / 100;
          v.currentTime = next;
          setTime(next);
          announce(`跳到 ${percent}% · ${formatSeconds(next)}`);
          break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, changeVolume, shortcutsOn, panel, subtitles.length, announce]);

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

      {/*
        The caption mirror. A `<track>` cue box cannot be positioned or resized
        from CSS on any engine, so the appearance settings would be decoration
        if the browser drew the captions itself.
      */}
      {captionsOn && cue && (
        <div
          data-subtitle-overlay="1"
          data-subtitle-size={style.size}
          data-subtitle-position={style.position}
          data-subtitle-bg={style.background ? "on" : "off"}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: "0 24px",
            pointerEvents: "none",
            zIndex: 5,
            // Top and middle hug the top of the picture; bottom sits above the
            // control bar so the captions are never half-hidden behind it.
            top: style.position === "top" ? 12 : style.position === "middle" ? "45%" : undefined,
            bottom: style.position === "bottom" ? (isFullscreen ? 52 : 8) : undefined,
          }}
        >
          <span
            data-subtitle-text="1"
            style={{
              fontSize: SUBTITLE_SIZE_PX[style.size],
              lineHeight: 1.4,
              color: "#fff",
              maxWidth: "90%",
              textAlign: "center",
              // The plate is the readable floor, not a preference.
              background: style.background ? "rgba(0, 0, 0, 0.62)" : "transparent",
              padding: style.background ? "2px 10px" : 0,
              borderRadius: style.background ? 6 : 0,
            }}
          >
            {cue}
          </span>
        </div>
      )}

      {/* Everything a key press did, for the eye and for a screen reader. */}
      <div
        data-announcement="1"
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          left: "50%",
          top: isFullscreen ? 72 : 44,
          transform: "translateX(-50%)",
          padding: "4px 12px",
          borderRadius: 999,
          fontSize: 12,
          color: "#fff",
          background: "rgba(0, 0, 0, 0.65)",
          pointerEvents: "none",
          opacity: announcement ? 1 : 0,
          transition: "opacity 200ms ease",
          zIndex: 6,
        }}
      >
        {/* The zero-width space alternates so repeating the same action is still
            an announcement rather than silence. */}
        {announcement
          ? `${announcement.text}${announcement.seq % 2 ? "\u200B" : ""}`
          : ""}
      </div>

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
        ref={controls}
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
          <button data-seek-back="1" onClick={() => seekBy(time - 10)} title="后退 10 秒 (←)">
            ⟲
          </button>
          {/*
            The mirror of the button above. The bar could rewind ten seconds but
            not skip forward, while → on the keyboard could — the same action
            was reachable only by people who happened not to be using the mouse.
          */}
          <button data-seek-forward="1" onClick={() => seekBy(time + 10)} title="快进 10 秒 (→)">
            ⟳
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
          {subtitles.length > 0 && (
            <>
              <button
                data-subtitle-toggle="1"
                className={panel === "subtitles" ? "on" : ""}
                onClick={() => setPanel((p) => (p === "subtitles" ? null : "subtitles"))}
                title="字幕 (C)"
                aria-pressed={captionsOn}
              >
                字幕{captionsOn ? " 开" : " 关"}
              </button>
              <button
                onClick={() => setCaptionsOn((on) => !on)}
                title="字幕开关 (C)"
                aria-pressed={captionsOn}
              >
                {captionsOn ? "💬" : "🚫"}
              </button>
            </>
          )}
          <button
            data-shortcuts-toggle="1"
            className={panel === "shortcuts" ? "on" : ""}
            onClick={() => setPanel((p) => (p === "shortcuts" ? null : "shortcuts"))}
            title="键盘快捷键"
            aria-expanded={panel === "shortcuts"}
          >
            ⌨
          </button>
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

        {panel === "subtitles" && (
          <div className="player-menu" data-subtitle-menu="1" style={{ minWidth: 176 }}>
            <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "2px 10px" }}>字号</div>
            {SUBTITLE_SIZE_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                data-subtitle-size-option={value}
                className={style.size === value ? "on" : ""}
                onClick={() => applyStyle({ ...style, size: value })}
              >
                {label}
              </button>
            ))}
            <div
              style={{
                fontSize: 11,
                color: "var(--text-faint)",
                padding: "6px 10px 2px",
                borderTop: "1px solid var(--border)",
                marginTop: 4,
              }}
            >
              位置
            </div>
            {SUBTITLE_POSITION_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                data-subtitle-position-option={value}
                className={style.position === value ? "on" : ""}
                onClick={() => applyStyle({ ...style, position: value })}
              >
                {label}
              </button>
            ))}
            <div
              style={{
                fontSize: 11,
                color: "var(--text-faint)",
                padding: "6px 10px 2px",
                borderTop: "1px solid var(--border)",
                marginTop: 4,
              }}
            >
              背景
            </div>
            <button
              data-subtitle-background="1"
              className={style.background ? "on" : ""}
              onClick={() => applyStyle({ ...style, background: !style.background })}
            >
              {style.background ? "半透明黑底（开）" : "半透明黑底（关）"}
            </button>
            <div
              data-subtitle-saved="1"
              style={{ fontSize: 11, color: "var(--text-faint)", padding: "6px 10px 0" }}
            >
              本片已记住：{SUBTITLE_SIZE_PX[style.size]}px ·{" "}
              {SUBTITLE_POSITION_OPTIONS.find(([v]) => v === style.position)?.[1]} ·{" "}
              {style.background ? "黑底" : "无底"}
            </div>
          </div>
        )}

        {panel === "shortcuts" && (
          <div className="player-menu" data-shortcuts-panel="1" style={{ minWidth: 208 }}>
            <div style={{ fontSize: 11, color: "var(--text-faint)", padding: "2px 10px 6px" }}>
              键盘快捷键
            </div>
            {SHORTCUTS.map((s) => (
              <div
                key={s.keys}
                data-shortcut-row={s.keys}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 12,
                  padding: "3px 10px",
                }}
              >
                <kbd style={{ fontFamily: "inherit", color: "var(--text-dim)" }}>{s.keys}</kbd>
                <span style={{ color: "var(--text-faint)" }}>{s.what}</span>
              </div>
            ))}
            <button
              data-shortcuts-enabled="1"
              className={shortcutsOn ? "on" : ""}
              style={{ marginTop: 4, borderTop: "1px solid var(--border)" }}
              onClick={() => {
                const next = !shortcutsOn;
                setShortcutsOn(next);
                writeShortcutsEnabled(next);
                announce(next ? "快捷键已开启" : "快捷键已关闭");
              }}
            >
              快捷键{shortcutsOn ? "已开启" : "已关闭"}（点击切换）
            </button>
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