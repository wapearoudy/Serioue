import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { lineAt, parseLrc, type LyricLine } from "./lyrics";

/** One playable track. */
export type Track = {
  url: string;
  title: string;
  /** Cover art, when the page offered one. */
  cover?: string;
  /** A `.lrc` file belonging to this track, when the page linked one. */
  lyricUrl?: string;
};

type Props = {
  tracks: Track[];
  title?: string;
  /** Index to start on; the rest of the list becomes the queue. */
  startAt?: number;
  onNextTrack?: (index: number) => void;
  /** Remembered volume (0-1), restored on open. */
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  /**
   * Sleep-timer options in minutes. Defaults to 15/30/45/60; the preview page
   * passes shorter ones so the behaviour can be tested without waiting an hour.
   */
  sleepMinutes?: number[];
};

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|wav|ogg|opus)(\?|#|$)/i;

/** True when a URL is an audio file the browser can play directly. */
export function isAudioUrl(url: string): boolean {
  return AUDIO_EXT.test(url);
}

/** `m:ss` or `h:mm:ss`. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

type Repeat = "off" | "one" | "all";

const REPEAT_GLYPH: Record<Repeat, string> = { off: "🔁", one: "🔂", all: "🔁" };
const REPEAT_TITLE: Record<Repeat, string> = {
  off: "不循环",
  one: "单曲循环",
  all: "列表循环",
};

/**
 * Sleep timer.
 *
 * `minutes` counts down to a wall-clock deadline and then fades out; `track-end`
 * fades out as the current track runs out. The distinction matters: only the
 * timed mode survives a track change — 「本曲结束」 names one track, so switching
 * tracks has to retire it rather than quietly fade the next one.
 */
export type SleepTimer =
  | { kind: "minutes"; minutes: number; deadline: number }
  | { kind: "track-end" };

/** The options every music client offers. Overridable so tests need not wait an hour. */
export const DEFAULT_SLEEP_MINUTES = [15, 30, 45, 60];

/** How long the volume ramp takes once the timer is due. */
export const SLEEP_FADE_SECONDS = 20;

/** `15` -> "15 分钟"; a fractional option (tests use these) -> "0:06". */
export function sleepOptionLabel(minutes: number): string {
  return minutes >= 1 ? `${minutes} 分钟` : formatTime(minutes * 60);
}

/** What the button shows while a timer is armed: `剩余 14:52` or `本曲结束`. */
export function sleepCountdown(timer: SleepTimer | null, leftSeconds: number): string {
  if (!timer) return "";
  return timer.kind === "track-end" ? "本曲结束" : `剩余 ${formatTime(Math.max(0, leftSeconds))}`;
}

/** A running volume ramp, kept out of state because rAF must not re-render. */
type Fade = {
  /** Generation this ramp belongs to; a newer one means this one is dead. */
  gen: number;
  /** Volume to restore if the ramp is interrupted. */
  base: number;
  start: number;
  durationMs: number;
};

/**
 * Music player with a real queue.
 *
 * The queue is the whole point: a music source yields dozens of tracks on one
 * page, so next/previous, shuffle and repeat all operate on the list rather
 * than on a single file. Playback uses one `<audio>` element and swaps its
 * `src`, which keeps position, volume and Media Session state consistent.
 */
export function MusicPlayer({
  tracks,
  title,
  startAt = 0,
  onNextTrack,
  volume = 0.8,
  onVolumeChange,
  sleepMinutes,
}: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const [index, setIndex] = useState(startAt);
  /** What the user asked for; the element follows it. */
  const [wantPlay, setWantPlay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vol, setVol] = useState(volume);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("off");
  const [error, setError] = useState<string | null>(null);

  /**
   * Sleep timer state.
   *
   * The live fields are mirrored into refs because the tick that fires the timer
   * and the click that cancels it must both see the current value without
   * waiting for a render. The ramp itself is deliberately *not* state: it runs on
   * `requestAnimationFrame` and writes straight to `audio.volume`, so it must
   * not re-render the player 60 times a second.
   */
  const [sleep, setSleep] = useState<SleepTimer | null>(null);
  const sleepRef = useRef<SleepTimer | null>(null);
  const [sleepLeft, setSleepLeft] = useState(0);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [fading, setFading] = useState(false);
  const [fadeLabel, setFadeLabel] = useState<string | null>(null);
  const [sleepNotice, setSleepNotice] = useState<string | null>(null);
  const fade = useRef<Fade | null>(null);
  const fadeGen = useRef(0);
  const rafId = useRef(0);
  /** Set when the timer itself paused playback, so `ended` does not skip ahead. */
  const stoppedBySleep = useRef(false);

  const options = useMemo(
    () => (sleepMinutes && sleepMinutes.length > 0 ? sleepMinutes : DEFAULT_SLEEP_MINUTES),
    [sleepMinutes],
  );

  /**
   * The queue is local state, not the prop, because a listener has to be able
   * to take a track out of it. Re-seeded whenever the page supplies a new list.
   */
  const [queue, setQueue] = useState<Track[]>(tracks);
  useEffect(() => {
    setQueue(tracks);
    setIndex((i) => Math.min(i, Math.max(0, tracks.length - 1)));
  }, [tracks]);

  const total = queue.length;
  const track = queue[index];

  /**
   * Lyrics for the current track, fetched through the backend because the lyric
   * host sends no CORS headers. A track without lyrics, a failed fetch and an
   * empty file are all the same to the user: no lyric panel.
   */
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  const lyricUrl = track?.lyricUrl;
  useEffect(() => {
    if (!lyricUrl) {
      setLyrics(null);
      return;
    }
    let cancelled = false;
    api
      .fetchText(lyricUrl)
      .then((raw) => {
        if (cancelled) return;
        const lines = parseLrc(raw);
        setLyrics(lines.length > 0 ? lines : null);
      })
      .catch(() => {
        // Missing lyrics are the normal case, not an error worth reporting.
        if (!cancelled) setLyrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lyricUrl]);

  /** Which line is showing now; -1 before the first timestamp. */
  const lyricIndex = lyrics ? lineAt(lyrics, position) : -1;

  // Keep the current line in view. A lyric column that has scrolled past the
  // song is worse than no lyrics at all, so the active line is centred on every
  // change. A manual scroll wins for a few seconds — otherwise dragging the
  // panel away would be fought by the very next line.
  const lyricsBox = useRef<HTMLDivElement>(null);
  const autoScrolling = useRef(false);
  const userScrolledAt = useRef(0);
  useEffect(() => {
    if (lyricIndex < 0) return;
    if (Date.now() - userScrolledAt.current < 3000) return;
    const box = lyricsBox.current;
    const line = box?.children[lyricIndex] as HTMLElement | undefined;
    if (!box || !line) return;
    autoScrolling.current = true;
    box.scrollTop = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2;
  }, [lyricIndex]);

  /** Take a track out, keeping the current one playing if it is not this one. */
  const removeTrack = useCallback((at: number) => {
    setQueue((prev) => prev.filter((_, i) => i !== at));
    setIndex((cur) => {
      if (at > cur) return cur;
      if (at < cur) return cur - 1;
      return 0;
    });
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setIndex(0);
    setWantPlay(false);
    const el = audio.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
    }
  }, []);

  /** Put the page's whole list back after a clear. */
  const restoreQueue = useCallback(() => {
    setQueue(tracks);
    setIndex(0);
  }, [tracks]);

  // A queue exhausted by shuffle or by the end of the list must not dead-end.
  // Shuffle picks a random track directly in `step`, so no extra ordering is
  // needed — and the visible list stays in its real order.

  const play = useCallback(
    (at: number) => {
      if (total === 0) return;
      setIndex(((at % total) + total) % total);
      setError(null);
      setWantPlay(true);
    },
    [total],
  );

  const toggle = useCallback(() => setWantPlay((w) => !w), []);

  // Keep the element's source in step with the selected track. Without this,
  // pressing play before touching the queue would call play() on an element
  // that has no source at all.
  useEffect(() => {
    const el = audio.current;
    if (!el || !track) return;
    if (el.getAttribute("src") !== track.url) {
      el.src = track.url;
      setPosition(0);
      setDuration(0);
    }
    if (wantPlay) {
      // A sleep fade ends at volume 0. Resuming must give the user their own
      // level back, otherwise the next track would start inaudible.
      if (!fade.current) el.volume = muted ? 0 : vol;
      stoppedBySleep.current = false;
      el.play()
        .then(() => setPlaying(true))
        .catch(() => setError("这一首无法播放：源可能已失效，或该格式不被支持。"));
      setSleepNotice(null);
    } else {
      el.pause();
    }
  }, [track, wantPlay, muted, vol]);

  const step = useCallback(
    (delta: number) => {
      if (total === 0) return;
      if (repeat === "one" && delta > 0) {
        play(index);
        return;
      }
      const at = shuffle ? Math.floor(Math.random() * total) : index + delta;
      if (!shuffle && repeat === "off" && index + delta >= total) {
        // End of a non-repeating list: stop rather than wrap silently.
        setWantPlay(false);
        setPosition(0);
        return;
      }
      play(at);
    },
    [index, play, repeat, shuffle, total],
  );

  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => {
    // Restart the track first, the way every music player does.
    const el = audio.current;
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      setPosition(0);
      return;
    }
    step(-1);
  }, [step]);

  const seek = useCallback((seconds: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = seconds;
    setPosition(seconds);
  }, []);

  const setAndReportVolume = useCallback(
    (v: number) => {
      setVol(v);
      setMuted(false);
      onVolumeChange?.(v);
    },
    [onVolumeChange],
  );

  // Volume and mute are element properties, so mirror them whenever they change.
  // A running sleep fade owns the element's volume, so it is left alone here —
  // otherwise the next render would slam the volume back up mid-ramp.
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.muted = muted;
    if (fade.current) return;
    el.volume = vol;
  }, [vol, muted]);

  // Restore the remembered volume once the element exists.
  useEffect(() => setVol(volume), [volume]);

  useEffect(() => {
    const el = audio.current;
    if (el && track && !fade.current) el.volume = muted ? 0 : vol;
  }, [track, vol, muted]);

  // -- sleep timer -----------------------------------------------------------

  /** Single writer for the timer, so the ref never lags behind the state. */
  const applySleep = useCallback((next: SleepTimer | null) => {
    sleepRef.current = next;
    setSleep(next);
    setSleepLeft(next && next.kind === "minutes" ? Math.max(0, (next.deadline - Date.now()) / 1000) : 0);
  }, []);

  /**
   * Stop a running ramp and put the volume back.
   *
   * Bumping the generation is what makes a cancel safe: the frame callback
   * compares the generation it captured against the current one, so a ramp that
   * is already in flight stops writing to `audio.volume` on its very next frame
   * instead of racing the restore and dragging the volume back down.
   */
  const cancelFade = useCallback(() => {
    fadeGen.current += 1;
    const running = fade.current;
    fade.current = null;
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = 0;
    setFading(false);
    setFadeLabel(null);
    if (!running) return;
    const el = audio.current;
    if (el) el.volume = running.base;
    // Keep the slider honest: the element is back at the user's own level.
    setVol(running.base);
  }, []);

  /**
   * Ramp the element's volume linearly to zero over `seconds`, then pause.
   *
   * The ramp drives `audio.volume` itself, not a CSS opacity on some wrapper:
   * the point of a sleep timer is that the sound actually stops, so muting a
   * div would leave the audio playing. Elapsed time is taken from the clock
   * rather than accumulated per frame, so a backgrounded tab that skipped frames
   * resumes on the ramp instead of restarting it.
   */
  const startFade = useCallback((seconds: number, label: string) => {
    const el = audio.current;
    if (!el) return;
    // Stop cleanly before starting a new ramp, and retry in a moment if the
    // element is not there yet.
    fadeGen.current += 1;
    const gen = fadeGen.current;
    const base = el.volume;
    const durationMs = Math.max(200, seconds * 1000);
    const start = performance.now();
    fade.current = { gen, base, start, durationMs };
    setFading(true);
    // The ramp outlives the countdown that triggered it, and it must stay
    // cancellable while it runs — hence its own visible label.
    setFadeLabel(label);

    const tick = () => {
      if (fadeGen.current !== gen) return;
      const node = audio.current;
      if (!node) return;
      const done = Math.min(1, (performance.now() - start) / durationMs);
      // A tiny epsilon keeps a track-end ramp from reaching the very last frame,
      // where pausing races the `ended` event into skipping to the next track.
      node.volume = Math.max(0, base * (1 - Math.min(1, done * 1.02)));
      if (done < 1) {
        rafId.current = requestAnimationFrame(tick);
        return;
      }
      fade.current = null;
      rafId.current = 0;
      node.volume = 0;
      node.pause();
      stoppedBySleep.current = true;
      setFading(false);
      setFadeLabel(null);
      setWantPlay(false);
      setSleepNotice(label);
    };
    rafId.current = requestAnimationFrame(tick);
  }, []);

  const chooseMinutes = useCallback(
    (minutes: number) => {
      cancelFade();
      applySleep({ kind: "minutes", minutes, deadline: Date.now() + minutes * 60_000 });
      setSleepNotice(null);
      setSleepOpen(false);
    },
    [applySleep, cancelFade],
  );

  const chooseTrackEnd = useCallback(() => {
    cancelFade();
    applySleep({ kind: "track-end" });
    setSleepNotice(null);
    setSleepOpen(false);
  }, [applySleep, cancelFade]);

  const cancelSleep = useCallback(() => {
    cancelFade();
    applySleep(null);
    setSleepNotice(null);
    setSleepOpen(false);
  }, [applySleep, cancelFade]);

  // 「本曲结束」 names one track, so a track change retires it. Without this the
  // timer would quietly fade whatever happens to be playing next.
  const trackUrl = track?.url;
  useEffect(() => {
    if (sleepRef.current?.kind === "track-end") {
      applySleep(null);
      setSleepNotice(null);
    }
    // Only a change of track retires the timer; arming it must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackUrl]);

  // Countdown for the timed mode. An interval, not `setTimeout`, so a throttled
  // background tab still stops the music when it comes back.
  useEffect(() => {
    if (!sleep || sleep.kind !== "minutes") return;
    const id = window.setInterval(() => {
      const current = sleepRef.current;
      if (!current || current.kind !== "minutes") return;
      const left = (current.deadline - Date.now()) / 1000;
      setSleepLeft(Math.max(0, left));
      if (left > 0) return;
      applySleep(null);
      setSleepOpen(false);
      startFade(SLEEP_FADE_SECONDS, "睡眠定时已到，播放已暂停");
    }, 200);
    return () => window.clearInterval(id);
  }, [sleep, applySleep, startFade]);

  // Watch the remaining track length for 「本曲结束」, starting the ramp early
  // enough that the track fades out rather than being cut off.
  useEffect(() => {
    if (!sleep || sleep.kind !== "track-end") return;
    const id = window.setInterval(() => {
      const el = audio.current;
      if (!el || fade.current || el.paused) return;
      const remaining = el.duration - el.currentTime;
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > SLEEP_FADE_SECONDS) return;
      applySleep(null);
      setSleepOpen(false);
      startFade(remaining, "本曲结束，播放已暂停");
    }, 200);
    return () => window.clearInterval(id);
  }, [sleep, applySleep, startFade]);

  // Never leave a ramp running after the player goes away.
  useEffect(
    () => () => {
      fadeGen.current += 1;
      if (rafId.current) cancelAnimationFrame(rafId.current);
      fade.current = null;
    },
    [],
  );

  // Keyboard control, but never while the user is typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          toggle();
          break;
        case "ArrowRight":
          if (e.ctrlKey || e.metaKey) next();
          else seek(Math.min(duration, position + 5));
          break;
        case "ArrowLeft":
          if (e.ctrlKey || e.metaKey) prev();
          else seek(Math.max(0, position - 5));
          break;
        case "ArrowUp":
          e.preventDefault();
          setAndReportVolume(Math.min(1, vol + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault();
          setAndReportVolume(Math.max(0, vol - 0.05));
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, next, prev, seek, duration, position]);

  // Nothing on the page to play at all — render nothing. An emptied queue is a
  // different case: the player stays, offering to put the list back, because a
  // clear that leaves no way back is a trap.
  if (tracks.length === 0) return null;

  const pct = duration > 0 ? (position / duration) * 100 : 0;

  /**
   * End of track.
   *
   * Three cases, in order: a sleep timer stopped playback here, a 「本曲结束」
   * timer is still armed (it fades just before the end, but a paused-and-resumed
   * track can still reach the end first), and otherwise it is just the queue
   * moving on.
   */
  const onEnded = useCallback(() => {
    const current = sleepRef.current;
    if (stoppedBySleep.current || current?.kind === "track-end") {
      stoppedBySleep.current = false;
      cancelFade();
      applySleep(null);
      setWantPlay(false);
      setSleepNotice("本曲结束，播放已暂停");
      return;
    }
    step(1);
  }, [applySleep, cancelFade, step]);

  return (
    <div className="music">
      <audio
        ref={audio}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={onEnded}
        onError={() => setError("这一首无法播放：源可能已失效，或该格式不被支持。")}
      />

      <div className="music-now">
        {track?.cover ? (
          <img className="music-cover" src={track.cover} alt="" />
        ) : (
          <div className="music-cover placeholder" aria-hidden="true">
            ♪
          </div>
        )}
        <div className="music-meta">
          <div className="music-title">{track?.title || `第 ${index + 1} 首`}</div>
          {title && <div className="music-album">{title}</div>}
          <div className="music-time">
            {formatTime(position)} / {formatTime(duration)}
          </div>
        </div>
      </div>

      <div className="music-seek">
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0)}
          step={0.5}
          value={Math.min(position, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="播放进度"
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
        />
      </div>

      <div className="music-controls">
        <button
          className={shuffle ? "on" : ""}
          onClick={() => setShuffle((s) => !s)}
          title={shuffle ? "随机播放：开" : "随机播放：关"}
          aria-pressed={shuffle}
        >
          🔀
        </button>
        <button onClick={prev} title="上一首 (Ctrl + ←)" disabled={total < 2}>
          ⏮
        </button>
        <button className="music-play" onClick={toggle} title={playing ? "暂停 (空格)" : "播放 (空格)"}>
          {playing ? "⏸" : "▶"}
        </button>
        <button onClick={next} title="下一首 (Ctrl + →)">
          ⏭
        </button>
        <button
          className={repeat !== "off" ? "on" : ""}
          onClick={() => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"))}
          title={REPEAT_TITLE[repeat]}
          aria-pressed={repeat !== "off"}
        >
          {REPEAT_GLYPH[repeat]}
          {repeat === "one" ? " 1" : ""}
        </button>

        <span className="spacer" />

        {/* Sleep timer. The countdown lives on the button itself: a timer that
            stops the music without saying so is worse than no timer at all. */}
        <div style={{ position: "relative" }}>
          <button
            data-sleep-toggle="1"
            className={sleep ? "on" : ""}
            onClick={() => setSleepOpen((o) => !o)}
            title={sleep ? `睡眠定时：${sleepCountdown(sleep, sleepLeft)}` : "睡眠定时"}
            aria-pressed={sleep !== null || fading}
            aria-expanded={sleepOpen}
            style={{ fontSize: 12, whiteSpace: "nowrap" }}
          >
            🌙{sleep ? ` ${sleepCountdown(sleep, sleepLeft)}` : ""}
            {fading ? " 淡出中" : ""}
          </button>
          {sleepOpen && (
            <div
              role="menu"
              aria-label="睡眠定时"
              style={{
                position: "absolute",
                right: 0,
                bottom: "100%",
                marginBottom: 6,
                zIndex: 20,
                display: "flex",
                flexDirection: "column",
                minWidth: 148,
                padding: 4,
                background: "var(--panel, #fff)",
                border: "1px solid var(--line, #ddd)",
                borderRadius: 8,
                boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
              }}
            >
              {options.map((m) => (
                <button
                  key={m}
                  role="menuitem"
                  data-sleep-option={m}
                  className="ghost"
                  style={{ textAlign: "left", padding: "6px 8px", fontSize: 12 }}
                  onClick={() => chooseMinutes(m)}
                >
                  {sleepOptionLabel(m)}
                </button>
              ))}
              <button
                role="menuitem"
                data-sleep-option="track-end"
                className="ghost"
                style={{ textAlign: "left", padding: "6px 8px", fontSize: 12 }}
                onClick={chooseTrackEnd}
              >
                本曲结束
              </button>
              {/* A fade in progress still belongs to the timer, so it stays cancellable. */}
              {(sleep || fading) && (
                <button
                  role="menuitem"
                  data-sleep-action="cancel"
                  className="ghost"
                  style={{
                    textAlign: "left",
                    padding: "6px 8px",
                    fontSize: 12,
                    borderTop: "1px solid var(--line, #ddd)",
                    marginTop: 2,
                  }}
                  onClick={cancelSleep}
                >
                  取消定时{fading ? "（淡出中，立即恢复音量）" : ""}
                </button>
              )}
            </div>
          )}
        </div>

        <button onClick={() => setMuted((m) => !m)} title={muted ? "取消静音" : "静音"}>
          {muted ? "🔇" : "🔊"}
        </button>
        <input
          className="music-volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : vol}
          onChange={(e) => setAndReportVolume(Number(e.target.value))}
          aria-label="音量"
          // During a fade the element's volume belongs to the ramp; a slider
          // that silently does nothing is worse than one that says so.
          disabled={fading}
          title={fading ? "睡眠定时淡出中" : "音量"}
          style={{ "--pct": `${(muted ? 0 : vol) * 100}%` } as React.CSSProperties}
        />
      </div>

      {error && <div className="music-error">{error}</div>}

      {(sleep || fading || sleepNotice) && (
        <div
          role="status"
          aria-live="polite"
          data-sleep-status={fading ? "fading" : sleep ? "armed" : "done"}
          style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}
        >
          {fading
            ? `${fadeLabel ?? "睡眠定时"}淡出中 · 正在降低音量并即将暂停`
            : sleep
              ? `睡眠定时已开启 · ${sleepCountdown(sleep, sleepLeft)}`
              : sleepNotice}
        </div>
      )}

      {lyrics && (
        <div
          className="music-lyrics"
          aria-label="歌词"
          ref={lyricsBox}
          onScroll={() => {
            // Our own scroll fires this too; only a real drag should hold off
            // the auto-follow.
            if (autoScrolling.current) {
              autoScrolling.current = false;
              return;
            }
            userScrolledAt.current = Date.now();
          }}
        >
          {lyrics.map((line, i) => (
            <button
              key={`${line.time}-${i}`}
              className={i === lyricIndex ? "now" : ""}
              onClick={() => seek(line.time)}
              title={formatTime(line.time)}
            >
              {line.text || "♪"}
            </button>
          ))}
        </div>
      )}

      {total > 0 && (
        <div className="music-queue-head">
          <span>播放队列 · {total} 首</span>
          <span className="spacer" />
          {total > 1 && (
            <button className="ghost" onClick={clearQueue} title="清空队列">
              清空
            </button>
          )}
        </div>
      )}

      {total === 0 && (
        <div className="music-queue-head">
          <span>播放队列已空</span>
          <span className="spacer" />
          <button className="ghost" onClick={restoreQueue}>
            恢复全部 {tracks.length} 首
          </button>
        </div>
      )}

      {total > 0 && (
        <ol className="music-queue">
          {queue.map((t, i) => (
            <li
              key={t.url}
              className={i === index ? "playing" : ""}
              onClick={() => {
                play(i);
                onNextTrack?.(i);
              }}
            >
              <span className="n">{i + 1}</span>
              <span className="t">{t.title || t.url.split("/").pop()}</span>
              <button
                className="remove"
                title="从队列中移除"
                aria-label={`移除 ${t.title || t.url}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeTrack(i);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Pick `<audio>` sources out of a rendered article body. */
export function extractAudio(html: string, base: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  const push = (raw: string | null) => {
    if (!raw || raw.startsWith("data:")) return;
    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      url = raw;
    }
    if (isAudioUrl(url) && !out.includes(url)) out.push(url);
  };
  doc.querySelectorAll("audio source[src], audio[src]").forEach((el) => push(el.getAttribute("src")));
  return out;
}

/** `song-01.mp3` -> `song01`, so a link and a track can be compared. */
function lyricKey(url: string): string {
  const name = url.split(/[?#]/)[0].split("/").pop() ?? "";
  return name
    .replace(/\.(lrc|mp3|flac|m4a|aac|wav|ogg|opus)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]/g, "");
}

/**
 * Pair each track with a lyric file linked on the same page.
 *
 * Music pages put lyrics next to the audio in three shapes: an `<a>` whose href
 * ends in `.lrc`, a `data-lrc` attribute, or a single file meant for the whole
 * album. Matching is by filename, and only the unambiguous single-file case is
 * accepted without it — attaching the wrong lyrics to a track is worse than
 * showing none.
 */
export function attachLyrics(tracks: Track[], html: string, base: string): Track[] {
  if (tracks.length === 0) return tracks;
  const doc = new DOMParser().parseFromString(html, "text/html");

  const candidates: string[] = [];
  const add = (raw: string | null) => {
    if (!raw || raw.startsWith("data:")) return;
    let url: string;
    try {
      url = new URL(raw, base).toString();
    } catch {
      url = raw;
    }
    if (/\.lrc(\?|#|$)/i.test(url) && !candidates.includes(url)) candidates.push(url);
  };
  doc.querySelectorAll("a[href], [data-lrc], link[rel=lyrics][href]").forEach((el) => {
    add(el.getAttribute("data-lrc") ?? el.getAttribute("href"));
  });
  if (candidates.length === 0) return tracks;

  const byKey = new Map<string, string>();
  for (const c of candidates) byKey.set(lyricKey(c), c);

  const single = tracks.length === 1 && candidates.length === 1 ? candidates[0] : null;

  return tracks.map((t) => {
    if (t.lyricUrl) return t;
    const match = byKey.get(lyricKey(t.url));
    const chosen = match ?? single;
    return chosen ? { ...t, lyricUrl: chosen } : t;
  });
}