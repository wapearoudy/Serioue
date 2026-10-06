import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  clearLyricOffset,
  effectiveLyricOffset,
  formatLyricOffset,
  lineAt,
  offsetPosition,
  parseLrc,
  parseLrcOffset,
  readLyricOffset,
  writeLyricOffset,
  writeSourceOffset,
  lyricSongKey,
  lyricSourceKey,
  clampOffset,
  OFFSET_FINE_STEP_MS,
  OFFSET_MAX_MS,
  OFFSET_MIN_MS,
  OFFSET_STEP_MS,
  type LyricLine,
} from "./lyrics";
import {
  readLastPlayed,
  readResumeMemory,
  readVolumeMemory,
  resumePoint,
  writeLastPlayed,
  writeResumeMemory,
  writeVolumeMemory,
} from "./musicMemory";
import { useKeyboardRows } from "./keyboardRow";

/** One playable track. */
export type Track = {
  url: string;
  title: string;
  /** Performer, when the page offered one. */
  artist?: string;
  /** Length in seconds, when the page offered one. */
  duration?: number;
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
  /**
   * Identity of the source the queue belongs to. Defaults to the album title;
   * two sources with the same title should pass something distinct.
   */
  sourceId?: string;
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

/* ---------------------------------------------------------------------------
   The queue, remembered
   ---------------------------------------------------------------------------
   A queue the listener has rearranged is theirs, not the page's: re-opening the
   same source should not silently undo their deletions and their 插播. Kept per
   source so two sources never argue over one list. */

export const QUEUE_STORE = "serious.musicQueue.v1";

export type QueueSnapshot = {
  /** Track URLs, in queue order. */
  urls: string[];
  /** Which of them was current. */
  index: number;
  /** Lengths learned while playing, so the list can show real times next time. */
  durations: Record<string, number>;
};

function readQueueStore(): Record<string, QueueSnapshot> {
  try {
    const raw = window.localStorage.getItem(QUEUE_STORE);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, QueueSnapshot> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const entry = v as Partial<QueueSnapshot>;
      if (!Array.isArray(entry.urls)) continue;
      out[k] = {
        urls: entry.urls.filter((u): u is string => typeof u === "string"),
        index: typeof entry.index === "number" && Number.isFinite(entry.index) ? entry.index : 0,
        durations:
          entry.durations && typeof entry.durations === "object"
            ? (entry.durations as Record<string, number>)
            : {},
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** The saved queue for one source, or null when it has never been arranged. */
export function readQueueState(source: string): QueueSnapshot | null {
  return readQueueStore()[source] ?? null;
}

export function writeQueueState(source: string, state: QueueSnapshot): void {
  if (!source) return;
  try {
    const store = readQueueStore();
    store[source] = state;
    window.localStorage.setItem(QUEUE_STORE, JSON.stringify(store));
  } catch {
    /* the queue still works for this session */
  }
}

/** Forget one source's queue, so the page's list is used again next time. */
export function clearQueueState(source: string): void {
  try {
    const store = readQueueStore();
    if (!(source in store)) return;
    delete store[source];
    window.localStorage.setItem(QUEUE_STORE, JSON.stringify(store));
  } catch {
    /* nothing to forget if storage is unavailable */
  }
}

/** `m:ss`, or `—` when the length is not known yet. Never `NaN`. */
export function formatDuration(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  return formatTime(seconds);
}

/** `15` -> "15 分钟"; a fractional option (tests use these) -> "0:06". */
export function sleepOptionLabel(minutes: number): string {
  return minutes >= 1 ? `${minutes} 分钟` : formatTime(minutes * 60);
}

/** What the button shows while a timer is armed: `剩余 14:52` or `本曲结束`. */
export function sleepCountdown(timer: SleepTimer | null, leftSeconds: number): string {
  if (!timer) return "";
  return timer.kind === "track-end" ? "本曲结束" : `剩余 ${formatTime(Math.max(0, leftSeconds))}`;
}

/**
 * Why playback failed, in the two terms a listener can act on.
 *
 * The old wording — 「源可能已失效，或该格式不被支持」 — collapsed three very
 * different problems into one sentence with an 「或」 in it, which leaves the
 * reader with nothing to do: a dead link is worth retrying, an unplayable codec
 * is not, and the request never reaching the element is a third thing again.
 */
export type PlaybackFailure = {
  /** Machine-readable, so the classes stay distinguishable in a test. */
  kind: "load" | "network" | "decode" | "unsupported" | "unknown";
  /** The `<audio>` element's MediaError code, when there was one. */
  code: number | null;
  title: string;
  /** What the listener can do about it. */
  hint: string;
};

/** MediaError codes, spelled out because the numbers are not self-describing. */
const MEDIA_ERR: Record<number, { kind: PlaybackFailure["kind"]; title: string; hint: string }> = {
  2: {
    kind: "network",
    title: "网络中断，或链接取不到这首音频",
    hint: "音频本身可能没问题。可以重试；网络恢复后再试一次多半就好了。",
  },
  3: {
    kind: "decode",
    title: "音频下载到了，但解不开",
    hint: "文件多半是坏的或下了一半。重试没用，换一个源更靠谱。",
  },
  4: {
    kind: "unsupported",
    title: "这个地址不是能播放的音频",
    hint: "可能是链接失效、返回了网页而不是音频，或者这个源的格式不支持。重试没用，换一个源。",
  },
};

/** Turn a `MediaError` code into something worth reading. */
export function describeMediaError(code: number | null | undefined): PlaybackFailure {
  const known = typeof code === "number" ? MEDIA_ERR[code] : undefined;
  if (known) return { ...known, code: code ?? null };
  return {
    kind: "unknown",
    code: typeof code === "number" ? code : null,
    title: "这一首没能播放",
    hint: "原因不明。可以重试一次；还是不行就换一个源。",
  };
}

/**
 * A `play()` that rejects is its own kind of failure.
 *
 * `AbortError` is not a failure at all: it is what the browser reports when the
 * source was swapped or playback was interrupted on purpose — which is exactly
 * what this player does when the listener skips a track.
 */
export function describePlayRejection(error: unknown): PlaybackFailure | null {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return null;
  return {
    kind: "load",
    code: null,
    title: "浏览器拒绝播放这个地址",
    hint: "可能地址不对、被拦截，或者返回的内容不是音频。重试一次，或换一个源。",
  };
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
 * Are these the same tracks in the same order?
 *
 * Used to keep a re-render from handing `setQueue` a new array it can tell is
 * identical: a fresh array every time is a state change every time, which is the
 * other half of the loop that freezes a page.
 */
function sameTracks(a: Track[], b: Track[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.url === b[i].url);
}

/** Merge remembered lengths in, returning the old object when nothing changes. */
function mergeDurations(
  prev: Record<string, number>,
  incoming: Record<string, number>,
): Record<string, number> {
  let changed = false;
  for (const [url, seconds] of Object.entries(incoming)) {
    if (prev[url] !== seconds) {
      changed = true;
      break;
    }
  }
  if (!changed) return prev;
  return { ...incoming, ...prev };
}

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
  sourceId,
}: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const [index, setIndex] = useState(startAt);
  /** What the user asked for; the element follows it. */
  const [wantPlay, setWantPlay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  /**
   * What this player's memory is filed under. Declared before the state that
   * reads it, so the initial volume can come from storage rather than from the
   * default prop.
   */
  const sourceKey = sourceId || title || tracks[0]?.url || "music";

  /**
   * Volume and mute, per source, seeded from what this source was last played
   * at. The incoming prop is only a default for a source with no memory yet.
   */
  const [vol, setVol] = useState(() => readVolumeMemory(sourceKey)?.volume ?? volume);
  const [muted, setMuted] = useState(() => readVolumeMemory(sourceKey)?.muted ?? false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("off");
  const [failure, setFailure] = useState<PlaybackFailure | null>(null);

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
  const keyboard = useKeyboardRows();
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

  /** What the lyric defaults are filed under. */
  const sourceLyricKey = lyricSourceKey(sourceKey);

  /** Lengths learned from the element, keyed by track URL. */
  const [durations, setDurations] = useState<Record<string, number>>({});

  /**
   * The queue is local state, not the prop, because a listener has to be able
   * to take a track out of it, reorder it, or empty it.
   *
   * When the page supplies a list, a queue this listener has already arranged
   * for the same source wins: only URLs the page still offers are kept, so a
   * track that disappeared upstream does not come back from storage.
   */
  const [queue, setQueue] = useState<Track[]>(tracks);
  /**
   * False until the restore above has had its say.
   *
   * Both effects run in the same commit on mount. Without this gate the persist
   * effect would write the page's untouched list over the arrangement that was
   * just read from storage, in the window before the restored state lands — so a
   * queue the listener arranged would silently become the page's list again.
   */
  const [queueReady, setQueueReady] = useState(false);

  /**
   * The list, keyed by *content* rather than by array identity.
   *
   * A parent that builds `tracks={[...]}` inline hands this component a new
   * array on every one of its renders. Depending on that identity would re-seed
   * the queue on each of them — and a re-seed that writes state, plus a persist
   * effect that writes storage on every state change, is the shape that becomes
   * the ArticleList freeze: two writers, each feeding the other. Depending on the
   * content means a re-render of the parent does nothing at all here.
   *
   * The key carries the fields the queue displays, not just the URLs: an article
   * re-fetched with better titles should still reach the list.
   */
  const tracksKey = JSON.stringify(
    tracks.map((t) => [t.url, t.title ?? "", t.artist ?? ""]),
  );
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  useEffect(() => {
    const list = tracksRef.current;
    const saved = readQueueState(sourceKey);
    if (saved && saved.urls.length > 0) {
      const byUrl = new Map(list.map((t) => [t.url, t]));
      const kept = saved.urls
        .map((u) => byUrl.get(u))
        .filter((t): t is Track => t !== undefined);
      if (kept.length > 0) {
        setQueue((prev) => (sameTracks(prev, kept) ? prev : kept));
        setIndex((cur) => {
          const next = Math.max(0, Math.min(saved.index, kept.length - 1));
          return next === cur ? cur : next;
        });
        setDurations((prev) => mergeDurations(prev, saved.durations));
        setQueueReady(true);
        return;
      }
    }
    setQueue((prev) => (sameTracks(prev, list) ? prev : list));
    setIndex((i) => Math.min(i, Math.max(0, list.length - 1)));
    setQueueReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracksKey, sourceKey]);

  // Remember the arrangement. Written on every change rather than on the way
  // out, because closing the tab is not something this code gets to observe.
  useEffect(() => {
    if (!queueReady || queue.length === 0) return;
    writeQueueState(sourceKey, {
      urls: queue.map((t) => t.url),
      index,
      durations,
    });
  }, [queueReady, queue, index, durations, sourceKey]);

  const total = queue.length;
  const track = queue[index];

  /**
   * Lyrics for the current track, fetched through the backend because the lyric
   * host sends no CORS headers. A track without lyrics, a failed fetch and an
   * empty file are all the same to the user: no lyric panel.
   */
  const [lyrics, setLyrics] = useState<LyricLine[] | null>(null);
  /** The `[offset:]` the file itself asks for, if any. */
  const [fileOffset, setFileOffset] = useState<number | null>(null);
  const lyricUrl = track?.lyricUrl;
  useEffect(() => {
    if (!lyricUrl) {
      setLyrics(null);
      setFileOffset(null);
      return;
    }
    let cancelled = false;
    api
      .fetchText(lyricUrl)
      .then((raw) => {
        if (cancelled) return;
        const lines = parseLrc(raw);
        setLyrics(lines.length > 0 ? lines : null);
        setFileOffset(parseLrcOffset(raw));
      })
      .catch(() => {
        // Missing lyrics are the normal case, not an error worth reporting.
        if (!cancelled) {
          setLyrics(null);
          setFileOffset(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lyricUrl]);

  /**
   * Manual lyric calibration.
   *
   * `offset` is what the panel is drawn with and changes as the slider moves;
   * the stored value is what survives a reload. Every adjustment is written for
   * this song straight away, because an offset a listener typed and then lost to
   * a page reload is worse than no calibration at all. The source-wide default
   * is a separate, deliberate choice.
   */
  const songLyricKey = track ? lyricSongKey(track) : "";
  const [offset, setOffset] = useState(0);
  /** The offset saved for this song, or null when it has never been set. */
  const [songOffset, setSongOffset] = useState<number | null>(null);
  const [calibrating, setCalibrating] = useState(false);

  // Load this song's calibration when the song changes. A song without its own
  // entry falls back to the source default, then to the file's own tag.
  useEffect(() => {
    if (!songLyricKey) {
      setOffset(0);
      setSongOffset(null);
      return;
    }
    const own = readLyricOffset(songLyricKey);
    setSongOffset(own);
    setOffset(effectiveLyricOffset(songLyricKey, sourceLyricKey, fileOffset));
  }, [songLyricKey, sourceLyricKey, fileOffset]);

  /** Move the lyric by `delta` ms and keep it saved for this song. */
  const adjustOffset = useCallback(
    (delta: number) => {
      setOffset((prev) => {
        const next = clampOffset(prev + delta);
        writeLyricOffset(songLyricKey, next);
        setSongOffset(next);
        return next;
      });
    },
    [songLyricKey],
  );

  /** Set an exact value, from the slider. */
  const setOffsetValue = useCallback(
    (ms: number) => {
      const next = clampOffset(ms);
      setOffset(next);
      writeLyricOffset(songLyricKey, next);
      setSongOffset(next);
    },
    [songLyricKey],
  );

  /** Make the current value the default for every song of this source. */
  const saveSourceOffset = useCallback(() => {
    writeSourceOffset(sourceLyricKey, offset);
  }, [sourceLyricKey, offset]);

  /** Forget this song's calibration and go back to the source default. */
  const resetOffset = useCallback(() => {
    clearLyricOffset(songLyricKey);
    setSongOffset(null);
    setOffset(effectiveLyricOffset(songLyricKey, sourceLyricKey, fileOffset));
  }, [songLyricKey, sourceLyricKey, fileOffset]);

  /** Which line is showing now, judged against the calibrated position. */
  const lyricIndex = lyrics ? lineAt(lyrics, offsetPosition(position, offset)) : -1;

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

  /**
   * 插播: play this one next.
   *
   * The item is moved to just after the current track, so the very next step
   * reaches it — which is the whole point of the gesture. The current track's
   * own index shifts down when the moved item came from before it, and the
   * insert lands relative to that new index so it really is second.
   */
  const playNextTrack = useCallback(
    (at: number) => {
      setQueue((prev) => {
        if (at < 0 || at >= prev.length) return prev;
        const item = prev[at];
        const rest = prev.filter((_, i) => i !== at);
        const current = at <= index ? Math.max(0, index - 1) : Math.min(index, rest.length - 1);
        const insertAt = Math.min(current + 1, rest.length);
        const next = [...rest.slice(0, insertAt), item, ...rest.slice(insertAt)];
        setIndex(current);
        return next;
      });
    },
    [index],
  );

  const clearQueue = useCallback(() => {
    setQueue([]);
    setIndex(0);
    setWantPlay(false);
    clearQueueState(sourceKey);
    const el = audio.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
    }
  }, [sourceKey]);

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
      // Moving to any song clears the previous song's failure: a notice about a
      // track the listener has already left is just noise.
      setFailure(null);
      setWantPlay(true);
    },
    [total],
  );

  const toggle = useCallback(() => setWantPlay((w) => !w), []);

  /**
   * Whether there is a next track to skip to.
   *
   * Positional on purpose: with shuffle on, "the next one" is arbitrary, and a
   * skip button that jumps somewhere random is a surprise. At the end of the
   * list it is simply false, and the notice says so.
   */
  const canSkip = total > 1 && index + 1 < total;

  /**
   * Try this track again.
   *
   * Routed through the same effect that starts playback, rather than a second
   * `load()`+`play()` of its own: two paths to the same outcome is how the two
   * of them end up reporting different reasons for the same failure. The token
   * is what makes the effect run again for an unchanged source.
   */
  const [retryToken, setRetryToken] = useState(0);
  const retryFailed = useCallback(() => {
    setFailure(null);
    setRetryToken((n) => n + 1);
  }, []);

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
    } else if (wantPlay && retryToken > 0) {
      // Same source, asked to try again: re-assigning `src` would not restart
      // anything, so the load has to be told to start over.
      el.load();
    }
    if (wantPlay) {
      // A sleep fade ends at volume 0. Resuming must give the user their own
      // level back, otherwise the next track would start inaudible.
      // Mute is `el.muted`, not a volume of 0: zeroing the volume would throw
      // away the level the listener chose and hand back silence on unmute.
      if (!fade.current) el.volume = vol;
      stoppedBySleep.current = false;
      // Pick the song up where it was left. Doing this *and* saying so is the
      // point: a resume without a word reads as a glitch, and a notice without
      // the seek is just a message.
      if (resumeAt !== null && el.currentTime < 0.5) {
        el.currentTime = resumeAt;
        setPosition(resumeAt);
        savedPosition.current = resumeAt;
        setResumeAt(null);
      }
      el.play()
        .then(() => setPlaying(true))
        .catch((e: unknown) => {
          // An AbortError here is this player swapping the source on purpose —
          // skipping a track aborts the previous play(). Reporting it would
          // flash an error at someone who just used the skip button.
          const described = describePlayRejection(e);
          if (!described) return;
          // The rejection and the element's error event describe the same
          // failure, and they arrive in either order. When the element already
          // knows the code, that is the better answer — otherwise every failure
          // collapses into the one generic "load" wording and the classes are
          // pointless.
          const fromElement = el.error ? describeMediaError(el.error.code) : null;
          setFailure(fromElement ?? described);
        });
      setSleepNotice(null);
    } else {
      el.pause();
    }
  }, [track, wantPlay, muted, vol, retryToken]);

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

  // Only apply an incoming prop when it actually changes. On mount the remembered
  // value is already in state, and re-applying the default would undo it.
  const appliedVolumeProp = useRef(volume);
  useEffect(() => {
    if (appliedVolumeProp.current === volume) return;
    appliedVolumeProp.current = volume;
    setVol(volume);
  }, [volume]);

  useEffect(() => {
    const el = audio.current;
    if (el && track && !fade.current) el.volume = vol;
  }, [track, vol]);

  // -- what this player remembers ---------------------------------------------

  /**
   * Volume and mute, per source.
   *
   * A listener who turns it down to 30% to fall asleep does not want the next
   * session — or the next source — to shout at them again.
   *
   * Adjusted during render rather than in an effect on purpose: an effect that
   * restores "once per source" is defeated by StrictMode's double invocation
   * (the second pass skips the restore and the default prop overwrites it), and
   * an effect that always restores would fight every later prop change. Doing
   * it while rendering makes it deterministic in both modes.
   */
  const [volumeSource, setVolumeSource] = useState(sourceKey);
  if (volumeSource !== sourceKey) {
    setVolumeSource(sourceKey);
    const remembered = readVolumeMemory(sourceKey);
    setVol(remembered ? remembered.volume : volume);
    setMuted(remembered ? remembered.muted : false);
  }

  useEffect(() => {
    // Written on every change: the app can be killed without warning, so
    // "on the way out" is not a moment this code gets to observe.
    writeVolumeMemory(sourceKey, { volume: vol, muted });
  }, [sourceKey, vol, muted]);

  /**
   * Where to pick up, per song.
   *
   * `resumeNotice` is what the viewer is told: resuming silently makes a
   * listener think they mis-remembered where they were.
   */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  /** The song this source was last playing, marked in the queue. */
  const [lastPlayedUrl, setLastPlayedUrl] = useState<string | null>(null);
  /** The position last written to storage, so it is not saved twice. */
  const savedPosition = useRef(0);
  /** Set once the track's length is known, so a position can be judged. */
  const [trackDuration, setTrackDuration] = useState(0);

  useEffect(() => {
    setLastPlayedUrl(readLastPlayed(sourceKey));
  }, [sourceKey]);

  const rememberPosition = useCallback(
    (seconds: number, completed = false) => {
      const el = audio.current;
      if (!el || !track) return;
      const url = el.getAttribute("src");
      if (!url) return;
      writeResumeMemory(url, { position: seconds, completed });
      savedPosition.current = seconds;
    },
    [track],
  );

  // Pick a position up when the element's source changes, not before: without
  // the duration there is no way to tell a saved position from a finished song.
  useEffect(() => {
    const el = audio.current;
    if (!el || !track) return;
    if (el.getAttribute("src") !== track.url) return;
    const memory = readResumeMemory(track.url);
    const at = resumePoint(memory, trackDuration);
    setResumeAt(at);
    setResumeNotice(
      at === null
        ? null
        : `已从 ${formatTime(at)} 继续 · 上次听到 ${formatTime(memory?.position ?? at)}`,
    );
    savedPosition.current = at ?? 0;
  }, [track, trackDuration]);

  /** Continue from the saved position, rather than silently doing it. */
  const continueAt = useCallback(() => {
    const el = audio.current;
    if (el && resumeAt !== null) {
      el.currentTime = resumeAt;
      setPosition(resumeAt);
      savedPosition.current = resumeAt;
    }
    setResumeAt(null);
  }, [resumeAt]);

  const startFromTop = useCallback(() => {
    const el = audio.current;
    if (el) {
      el.currentTime = 0;
      writeResumeMemory(el.getAttribute("src") ?? track?.url ?? "", { position: 0, completed: false });
    }
    setPosition(0);
    setResumeAt(null);
    setResumeNotice(null);
    savedPosition.current = 0;
  }, [track]);

  // -- sleep timer -----------------------------------------------------------

  // Which song this source was last playing.
  //
  // Written from the element's `playing` event, not from an effect that watches
  // the `playing` *state*. That state is still true across a track switch, so it
  // would write the newly selected song before anything had actually sounded —
  // including when that song then fails to play at all. The element's own event
  // is the honest signal, and the only one that means "heard".
  const markAsLastPlayed = useCallback(() => {
    if (!track) return;
    writeLastPlayed(sourceKey, track.url);
    setLastPlayedUrl(track.url);
  }, [track, sourceKey]);

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
   * The queue's total length, or `—` when nothing in it is known yet.
   *
   * Adding up only the lengths that exist and printing a total would be a lie:
   * three known tracks out of nine is not the length of this queue.
   */
  /** Where the remembered song sits in the current queue, or -1 if it is gone. */
  const lastIndex = lastPlayedUrl ? queue.findIndex((t) => t.url === lastPlayedUrl) : -1;

  const knownDurations = queue.map((t) => durations[t.url] ?? t.duration);
  const queueTotal = knownDurations.every((d) => typeof d === "number" && Number.isFinite(d) && d > 0)
    ? formatTime(knownDurations.reduce<number>((sum, d) => sum + (d as number), 0))
    : "—";

  /**
   * End of track.
   *
   * Three cases, in order: a sleep timer stopped playback here, a 「本曲结束」
   * timer is still armed (it fades just before the end, but a paused-and-resumed
   * track can still reach the end first), and otherwise it is just the queue
   * moving on.
   */
  const onEnded = useCallback(() => {
    // A song that played to its end is finished, not "at 99%": without this a
    // finished song would be resumed to its last second forever.
    const el = audio.current;
    const url = el?.getAttribute("src");
    if (url) writeResumeMemory(url, { position: 0, completed: true });
    savedPosition.current = 0;
    setResumeAt(null);
    setResumeNotice(null);
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

  // Save on the way out, including when the component unmounts mid-playback.
  useEffect(() => {
    const onLeave = () => {
      const el = audio.current;
      if (!el || el.paused) return;
      rememberPosition(el.currentTime);
    };
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("visibilitychange", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onLeave);
      onLeave();
    };
  }, [rememberPosition]);

  return (
    <div
      className="music"
      // The player's own idea of "is playing", published so a test can read the
      // state instead of guessing it from a button glyph. It is deliberately
      // separate from `<audio>.paused`: this one is the component's belief, and
      // comparing the two is how a state/event mix-up gets caught.
      data-playing={playing ? "1" : "0"}
    >
      <audio
        ref={audio}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        // Fires when the element really starts (or resumes) producing sound —
        // not when a track is merely selected, and not when play() was merely
        // called on something that then failed to start.
        onPlaying={markAsLastPlayed}
        onPause={() => {
          setPlaying(false);
          // Pausing is a deliberate moment, so it is the natural place to record
          // where the listener was. Without it, closing the app straight after a
          // pause would lose the position they had reached.
          const el = audio.current;
          if (el && el.currentTime > 0) rememberPosition(el.currentTime);
        }}
        onTimeUpdate={(e) => {
          const seconds = e.currentTarget.currentTime;
          setPosition(seconds);
          // Roughly twice a second is plenty for a store: closer than that and
          // the writes cost more than they are worth, further apart and closing
          // the app loses the last few seconds.
          if (Math.abs(seconds - savedPosition.current) >= 1) {
            rememberPosition(seconds);
          }
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDuration(el.duration || 0);
          setTrackDuration(el.duration || 0);
          // Learn the length so the queue can show real times, including after a
          // reload. A `—` is honest; a wrong number is not.
          const url = el.getAttribute("src");
          const seconds = el.duration;
          if (url && Number.isFinite(seconds) && seconds > 0) {
            setDurations((prev) =>
              prev[url] === seconds ? prev : { ...prev, [url]: seconds },
            );
          }
        }}
        onEnded={onEnded}
        onError={(e) => {
          const el = e.currentTarget;
          const media = el.error;
          // MEDIA_ERR_ABORTED (1) is the element being interrupted on purpose,
          // which this player does when the source is swapped. It is not a
          // failure the listener can do anything about, so it stays silent.
          if (media && media.code === 1) return;
          // The element can report an error for a source that has already been
          // replaced; only the current track's failure is worth showing.
          const current = el.getAttribute("src");
          if (current && track && current !== track.url) return;
          setFailure(describeMediaError(media?.code));
        }}
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
          // The slider shows the level the listener chose even while muted:
          // muting is `el.muted`, not a volume of zero, so zeroing the thumb
          // here would hide the level they will get back when they unmute.
          value={vol}
          onChange={(e) => setAndReportVolume(Number(e.target.value))}
          aria-label="音量"
          // During a fade the element's volume belongs to the ramp; a slider
          // that silently does nothing is worse than one that says so.
          disabled={fading}
          title={fading ? "睡眠定时淡出中" : "音量"}
          style={{ "--pct": `${vol * 100}%` } as React.CSSProperties}
        />
      </div>

      {/*
        A failure the listener can act on. Two things are deliberate here:
        the reason is stated rather than guessed at, and the way out is a button
        that really moves — a queue exists precisely so a bad track does not
        have to end the listening.
      */}
      {failure && (
        <div
          className="music-error"
          role="alert"
          data-failure-kind={failure.kind}
          data-failure-code={failure.code ?? ""}
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div>
            <strong data-failure-title="1">{failure.title}</strong>
            <div style={{ fontSize: 12, marginTop: 2 }} data-failure-hint="1">
              {failure.hint}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              data-skip-failed="1"
              className="ghost"
              // At the end of the queue there is nothing to skip to, and a
              // button that looks live but does nothing is worse than none.
              disabled={!canSkip}
              onClick={() => canSkip && play(index + 1)}
              title={canSkip ? "跳到队列里的下一首" : "队列里没有下一首了"}
            >
              跳过这一首
            </button>
            <button
              data-retry-failed="1"
              className="ghost"
              onClick={retryFailed}
              title="再试一次这一首"
            >
              重试
            </button>
            <button data-dismiss-failure="1" className="ghost" onClick={() => setFailure(null)}>
              知道了
            </button>
            {!canSkip && (
              <span data-skip-unavailable="1" style={{ fontSize: 12, alignSelf: "center" }}>
                已经到队列最后一首了，回列表换一首吧。
              </span>
            )}
          </div>
        </div>
      )}

      {/*
        Resuming is never silent. A track that starts at 2:30 with no word about
        it reads as a bug — or worse, as the listener having mis-remembered
        where they were — so the position and the choice are both on screen.
      */}
      {(resumeAt !== null || resumeNotice) && (
        <div
          role="status"
          aria-live="polite"
          data-resume={resumeAt !== null ? "pending" : "told"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--text-dim)",
            marginTop: 6,
          }}
        >
          <span data-resume-text="1">{resumeNotice}</span>
          {resumeAt !== null && (
            <button className="ghost" data-resume-continue="1" onClick={continueAt}>
              从 {formatTime(resumeAt)} 继续
            </button>
          )}
          {(resumeAt !== null || resumeNotice) && (
            <button className="ghost" data-resume-top="1" onClick={startFromTop}>
              从头开始
            </button>
          )}
        </div>
      )}

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

      {/* Calibration, shown only when there is something to calibrate. */}
      {lyrics && (
        <div className="music-calibration" data-lyric-offset="1">
          <button
            className="ghost"
            data-offset-toggle="1"
            onClick={() => setCalibrating((c) => !c)}
            title="歌词时间轴校准"
            aria-expanded={calibrating}
          >
            歌词校准
          </button>
          {calibrating && (
            <div data-offset-panel="1" style={{ marginTop: 6, fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  data-offset-step="-50"
                  onClick={() => adjustOffset(-OFFSET_STEP_MS)}
                  title="歌词延后 50ms"
                >
                  −50ms
                </button>
                <button
                  data-offset-fine="-1"
                  onClick={() => adjustOffset(-OFFSET_FINE_STEP_MS)}
                  title="歌词延后 10ms"
                >
                  −10ms
                </button>
                <input
                  data-offset-slider="1"
                  type="range"
                  min={OFFSET_MIN_MS}
                  max={OFFSET_MAX_MS}
                  step={OFFSET_STEP_MS}
                  value={offset}
                  onChange={(e) => setOffsetValue(Number(e.target.value))}
                  aria-label="歌词偏移"
                  style={{ flex: 1, minWidth: 140 }}
                />
                <button
                  data-offset-fine="1"
                  onClick={() => adjustOffset(OFFSET_FINE_STEP_MS)}
                  title="歌词提前 10ms"
                >
                  +10ms
                </button>
                <button
                  data-offset-step="50"
                  onClick={() => adjustOffset(OFFSET_STEP_MS)}
                  title="歌词提前 50ms"
                >
                  +50ms
                </button>
              </div>
              {/* Both the number and the direction: "-400" alone does not say
                  which way to move the lyric. */}
              <div style={{ marginTop: 6 }} data-offset-readout="1">
                <strong data-offset-ms="1">{offset} ms</strong> · {formatLyricOffset(offset)}
                {songOffset === null ? " · 本曲尚未保存" : " · 已保存到本机（本曲）"}
                {fileOffset !== null && songOffset === null
                  ? ` · 文件自带 ${fileOffset} ms`
                  : ""}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <button
                  data-offset-save-song="1"
                  className="ghost"
                  onClick={() => setOffsetValue(offset)}
                  title="把当前偏移记为这一首的默认"
                >
                  保存为该歌默认
                </button>
                <button
                  data-offset-save-source="1"
                  className="ghost"
                  onClick={saveSourceOffset}
                  title="同一来源的其他歌也用这个偏移"
                >
                  保存为该源默认
                </button>
                <button data-offset-reset="1" className="ghost" onClick={resetOffset}>
                  重置
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {total > 0 && (
        <div className="music-queue-head" data-queue-head="1">
          {/* What the listener is actually looking at: how many, which one, how
              long the whole thing is. A queue you cannot take in is a list. */}
          <span data-queue-summary="1">
            播放队列 · {total} 首 · 第 {index + 1}/{total} 首 · 总时长{" "}
            <span data-queue-total="1">{queueTotal}</span>
          </span>
          <span className="spacer" />
          {/*
            One click back to where the listener left off. Only offered when the
            remembered song is in this queue and is not the one already showing —
            a "continue" that is already happening is noise.
          */}
          {lastIndex >= 0 && lastIndex !== index && (
            <button
              className="ghost"
              data-continue-last="1"
              onClick={() => {
                play(lastIndex);
                onNextTrack?.(lastIndex);
              }}
              title="继续上次在听的曲目"
            >
              继续上次：{queue[lastIndex]?.title || queue[lastIndex]?.url.split("/").pop()}
            </button>
          )}
          <button
            className="ghost"
            data-queue-next="1"
            onClick={next}
            disabled={total < 2}
            // Deliberately not "下一首" in the title: that is the transport
            // button's name, and two buttons answering to it is one too many.
            title="按队列顺序播放下一项"
          >
            下一首
          </button>
          <button className="ghost" onClick={clearQueue} title="清空队列" data-queue-clear="1">
            清空
          </button>
        </div>
      )}

      {total === 0 && (
        <div className="music-queue-head" data-queue-empty="1">
          <span>播放队列已空 —— 没有可播放的曲目了，播放已停止。</span>
          <span className="spacer" />
          <button className="ghost" onClick={restoreQueue} data-queue-restore="1">
            恢复全部 {tracks.length} 首
          </button>
        </div>
      )}

      {total > 0 && (
        <ol className="music-queue">
          {queue.map((t, i) => {
                const pick = () => {
                  play(i);
                  onNextTrack?.(i);
                };
                return (
                  <li
                    key={t.url}
                    className={i === index ? "playing" : ""}
                    data-queue-item={t.url}
                    data-queue-index={i}
                    onClick={pick}
                    // Picking another song from the queue was mouse-only. This is
                    // the one edit in this file for the keyboard round, kept local
                    // so it cannot collide with the audio work next to it.
                    {...keyboard.propsFor(`queue:${t.url}`, pick, {
                      label: `第 ${i + 1} 首 ${t.title || t.url.split("/").pop()}`,
                    })}
                    aria-current={i === index ? "true" : undefined}
                  >
              <span className="n">{i + 1}</span>
              {/* Title, performer and length stay together on the left: the row's
                  clickable area has to stay the row itself, because that is what
                  everyone — including the existing tests — clicks. */}
              <span className="t">
                <span data-queue-title="1">
                  {t.title || t.url.split("/").pop()}
                  {/* Which song this source was last playing: the queue survives a
                      restart, so without this the listener is looking at a list
                      with no idea which one they were on. */}
                  {/* A fact about memory, not about the current row: it stays even when this
                      song is the one already playing. */}
                  {t.url === lastPlayedUrl && (
                    <em
                      data-last-played="1"
                      title="上次在听"
                      style={{
                        marginLeft: 6,
                        fontStyle: "normal",
                        fontSize: 11,
                        color: "var(--accent)",
                      }}
                    >
                      上次在听
                    </em>
                  )}
                </span>
                <span className="music-queue-sub">
                  {/* `—` rather than an empty cell: a missing performer or length
                      is information, a blank looks like a rendering bug. */}
                  <span data-queue-artist="1">{t.artist || "—"}</span>
                  <span data-queue-duration="1">
                    {formatDuration(durations[t.url] ?? t.duration)}
                  </span>
                </span>
              </span>
              <button
                data-queue-insert={t.url}
                title="插播：移到当前这首之后播放"
                aria-label={`插播 ${t.title || t.url}`}
                onClick={(e) => {
                  e.stopPropagation();
                  playNextTrack(i);
                }}
              >
                插播
              </button>
              <button
                className="remove"
                title="从队列中移除"
                aria-label={`移除 ${t.title || t.url}`}
                data-queue-remove={t.url}
                onClick={(e) => {
                  e.stopPropagation();
                  removeTrack(i);
                }}
              >
                ✕
              </button>
                  </li>
                );
              })}
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