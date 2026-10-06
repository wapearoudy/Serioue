// LRC lyrics: parsing and time lookup.
//
// Lyric files in the wild are not standardised. One line can carry several
// timestamps, the fraction separator may be `.` or `:`, and metadata tags
// (`[ti:]`, `[ar:]`, `[al:]`) sit on the same lines as real lyrics. The parser
// below accepts all of that and ignores everything it cannot use, because a
// partially readable lyric is worth more than a rejection.

export type LyricLine = {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
};

/** `[mm:ss.xx]`, `[mm:ss:xx]`, `[mm:ss]` and `[hh:mm:ss.xx]`. */
const TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Metadata that is not a timestamp: `[ti:title]`, `[ar:artist]`, `[offset:-500]`. */
const META = /^\[(ti|ar|al|by|offset|re|ve|length):/i;

/**
 * Parse an LRC file into timed lines, sorted by time.
 *
 * Lines that carry no timestamp are dropped: there is no honest moment to show
 * them. Timestamps with no text are kept, because that is how an instrumental
 * gap is usually written.
 */
export function parseLrc(raw: string): LyricLine[] {
  const out: LyricLine[] = [];

  for (const raw_line of raw.split(/\r\n|\r|\n/)) {
    const line = raw_line.trim();
    if (!line || META.test(line)) continue;

    TAG.lastIndex = 0;
    const times: number[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG.exec(line)) !== null) {
      // Only timestamps at the start of a line count; a bracket further along
      // is part of the text.
      if (match.index !== last) break;
      last = TAG.lastIndex;
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      // `.5` means half a second, `.05` five hundredths; so does `:05`. Normalise
      // by the number of digits written rather than by parsing as a fraction.
      const frac = match[3] ? Number(match[3]) / 10 ** match[3].length : 0;
      times.push(minutes * 60 + seconds + frac);
    }
    if (times.length === 0) continue;

    const text = line.slice(last).trim();
    for (const time of times) out.push({ time, text });
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * The index of the line that should be showing at `time`, or -1 before the
 * first timestamp.
 *
 * Binary search, because `timeupdate` fires about four times a second and a
 * full lyric sheet can run to hundreds of lines.
 */
export function lineAt(lines: LyricLine[], time: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/* ---------------------------------------------------------------------------
   Manual calibration
   ---------------------------------------------------------------------------
   A lyric sheet that is systematically a second early is the single most
   common way a music client feels broken, and no amount of automatic parsing
   fixes it: only the listener can say how far off this recording is. The
   offsets live here, keyed per song and per source, because one number for the
   whole installation is worse than none — a viewer who finds track 1 runs
   200 ms late does not want track 9 shifted the same way. */

export const LYRIC_OFFSET_STORE = "serious.lyricOffset.v1";

/** How far a lyric may be moved, and in what increments. */
export const OFFSET_MIN_MS = -5000;
export const OFFSET_MAX_MS = 5000;
export const OFFSET_STEP_MS = 50;
export const OFFSET_FINE_STEP_MS = 10;

/** Keep a value inside the range the slider and the store agree on. */
export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(OFFSET_MIN_MS, Math.min(OFFSET_MAX_MS, Math.round(ms)));
}

/**
 * The identity a lyric offset belongs to.
 *
 * The lyric file is preferred: two sources can ship the same audio filename,
 * while a `.lrc` belongs to exactly one recording.
 */
export function lyricSongKey(track: { url: string; lyricUrl?: string }): string {
  return track.lyricUrl || track.url;
}

/** The identity a source-wide default belongs to. */
export function lyricSourceKey(sourceId: string): string {
  return `source:${sourceId || "unknown"}`;
}

function readOffsetStore(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(LYRIC_OFFSET_STORE);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = clampOffset(v);
    }
    return out;
  } catch {
    // Private mode, or a store written by an older build. Neither is worth
    // breaking playback over.
    return {};
  }
}

function writeOffsetStore(store: Record<string, number>): void {
  try {
    window.localStorage.setItem(LYRIC_OFFSET_STORE, JSON.stringify(store));
  } catch {
    /* the adjustment still applies to this session */
  }
}

/** The offset saved for one song, or null when this song has never been set. */
export function readLyricOffset(songKey: string): number | null {
  const value = readOffsetStore()[songKey];
  return value === undefined ? null : value;
}

/** Save an offset for one song. */
export function writeLyricOffset(songKey: string, ms: number): void {
  const store = readOffsetStore();
  store[songKey] = clampOffset(ms);
  writeOffsetStore(store);
}

/** Save a default that every song of this source without its own entry uses. */
export function writeSourceOffset(sourceKey: string, ms: number): void {
  const store = readOffsetStore();
  store[sourceKey] = clampOffset(ms);
  writeOffsetStore(store);
}

/**
 * Forget one song's offset, so it falls back to the source default.
 *
 * With no key the song falls back to what it would have used anyway — which is
 * why this is a reset and not a write of zero.
 */
export function clearLyricOffset(songKey: string): void {
  const store = readOffsetStore();
  if (!(songKey in store)) return;
  delete store[songKey];
  writeOffsetStore(store);
}

/**
 * The offset to use right now: the song's own if it has one, otherwise the
 * source default, otherwise the file's own `[offset:]` tag, otherwise nothing.
 */
export function effectiveLyricOffset(
  songKey: string,
  sourceKey: string,
  fileOffsetMs?: number | null,
): number {
  const own = readLyricOffset(songKey);
  if (own !== null) return own;
  const source = readLyricOffset(sourceKey);
  if (source !== null) return source;
  if (typeof fileOffsetMs === "number" && Number.isFinite(fileOffsetMs)) {
    return clampOffset(fileOffsetMs);
  }
  return 0;
}

/**
 * The offset in words, because "−400" tells nobody whether the lyric should
 * come earlier or later. A positive offset means the lyric shows earlier.
 */
export function formatLyricOffset(ms: number): string {
  if (!ms) return "未校准（0 ms）";
  return ms > 0 ? `歌词提前 ${ms} ms` : `歌词延后 ${Math.abs(ms)} ms`;
}

/** The audio position a lyric line is judged against, given an offset. */
export function offsetPosition(position: number, offsetMs: number): number {
  return position - clampOffset(offsetMs) / 1000;
}

/**
 * The `[offset:]` tag some files carry, in milliseconds.
 *
 * The LRC convention adds the value to every timestamp, so a positive offset
 * makes lyrics appear earlier — the same sign used above. Returned separately
 * so it can be a *starting point* the listener overrides, rather than a value
 * silently baked into every line.
 */
export function parseLrcOffset(raw: string): number | null {
  const match = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}