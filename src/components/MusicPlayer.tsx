import { useCallback, useEffect, useRef, useState } from "react";
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
 * Music player with a real queue.
 *
 * The queue is the whole point: a music source yields dozens of tracks on one
 * page, so next/previous, shuffle and repeat all operate on the list rather
 * than on a single file. Playback uses one `<audio>` element and swaps its
 * `src`, which keeps position, volume and Media Session state consistent.
 */
export function MusicPlayer({ tracks, title, startAt = 0, onNextTrack, volume = 0.8, onVolumeChange }: Props) {
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
      el.play()
        .then(() => setPlaying(true))
        .catch(() => setError("这一首无法播放：源可能已失效，或该格式不被支持。"));
    } else {
      el.pause();
    }
  }, [track, wantPlay]);

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
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.volume = vol;
    el.muted = muted;
  }, [vol, muted]);

  // Restore the remembered volume once the element exists.
  useEffect(() => setVol(volume), [volume]);

  useEffect(() => {
    const el = audio.current;
    if (el && track) el.volume = muted ? 0 : vol;
  }, [track, vol, muted]);

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

  return (
    <div className="music">
      <audio
        ref={audio}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={next}
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
          style={{ "--pct": `${(muted ? 0 : vol) * 100}%` } as React.CSSProperties}
        />
      </div>

      {error && <div className="music-error">{error}</div>}

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