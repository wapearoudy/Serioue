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