// What the music player remembers between visits.
//
// Three things, three stores, all keyed so one source cannot pollute another:
// the volume, where each song was left, and which song was playing. They live
// here rather than inside `MusicPlayer.tsx` because they are plain functions
// over `localStorage` with no React in them — the same reasoning as
// `lyrics.ts` and `videoQuality.ts` beside them.

/** Volume and mute, per source. */
export const VOLUME_STORE_KEY = "serious.musicVolume.v1";

/** Playback position, per song. */
export const RESUME_STORE_KEY = "serious.musicResume.v1";

/** The song that was playing when the app was last closed, per source. */
export const LAST_PLAYED_STORE_KEY = "serious.musicLastPlayed.v1";

/**
 * Below this, a position is not worth resuming.
 *
 * Ten seconds is long enough that a resume is obviously deliberate, and short
 * enough that a listener who stopped "right at the start" is not thrown back to
 * a song they have barely heard.
 */
export const RESUME_MIN_SECONDS = 10;

/**
 * Above this, the song is treated as finished.
 *
 * Without it, reopening a song that had reached its end would drop the listener
 * back at the last second of music — technically the saved position, and a
 * worse experience than starting over.
 */
export const RESUME_MAX_RATIO = 0.95;

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(key: string, value: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the session still works; only the memory is lost */
  }
}

/* -- volume ---------------------------------------------------------------- */

export type VolumeMemory = { volume: number; muted: boolean };

/** The volume this source was last played at, or null when it has no memory. */
export function readVolumeMemory(source: string): VolumeMemory | null {
  const entry = readJson(VOLUME_STORE_KEY)[source];
  if (!entry || typeof entry !== "object") return null;
  const { volume, muted } = entry as Partial<VolumeMemory>;
  if (typeof volume !== "number" || !Number.isFinite(volume)) return null;
  return {
    volume: Math.max(0, Math.min(1, volume)),
    muted: muted === true,
  };
}

export function writeVolumeMemory(source: string, memory: VolumeMemory): void {
  if (!source) return;
  const store = readJson(VOLUME_STORE_KEY);
  store[source] = {
    volume: Math.max(0, Math.min(1, memory.volume)),
    muted: memory.muted === true,
  };
  writeJson(VOLUME_STORE_KEY, store);
}

/** Forget one source's volume, so the default applies again. */
export function clearVolumeMemory(source: string): void {
  const store = readJson(VOLUME_STORE_KEY);
  if (!(source in store)) return;
  delete store[source];
  writeJson(VOLUME_STORE_KEY, store);
}

/* -- playback position ------------------------------------------------------ */

export type ResumeMemory = {
  /** Seconds from the start of the track. */
  position: number;
  /** Set when the track played to its end; the position is then meaningless. */
  completed: boolean;
};

/** The saved position for one song, or null when it has never been played. */
export function readResumeMemory(trackUrl: string): ResumeMemory | null {
  const entry = readJson(RESUME_STORE_KEY)[trackUrl];
  if (!entry || typeof entry !== "object") return null;
  const { position, completed } = entry as Partial<ResumeMemory>;
  if (typeof position !== "number" || !Number.isFinite(position)) return null;
  return { position: Math.max(0, position), completed: completed === true };
}

export function writeResumeMemory(trackUrl: string, memory: ResumeMemory): void {
  if (!trackUrl) return;
  const store = readJson(RESUME_STORE_KEY);
  store[trackUrl] = {
    position: Math.max(0, memory.position),
    completed: memory.completed === true,
  };
  writeJson(RESUME_STORE_KEY, store);
}

/** Forget one song's position, so it starts from the top next time. */
export function clearResumeMemory(trackUrl: string): void {
  const store = readJson(RESUME_STORE_KEY);
  if (!(trackUrl in store)) return;
  delete store[trackUrl];
  writeJson(RESUME_STORE_KEY, store);
}

/**
 * Where playback should actually start, or null to start from the top.
 *
 * The three "do not resume" cases live together on purpose: a song finished,
 * barely started, or past its own end. Each of them means the same thing to a
 * listener — start it again.
 */
export function resumePoint(memory: ResumeMemory | null, duration: number): number | null {
  if (!memory || memory.completed) return null;
  const seconds = memory.position;
  if (!Number.isFinite(seconds) || seconds < RESUME_MIN_SECONDS) return null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (seconds >= duration * RESUME_MAX_RATIO) return null;
  if (seconds >= duration - 1) return null;
  return Math.min(seconds, duration);
}

/* -- which song was playing --------------------------------------------------- */

/** The song this source was last playing, or null. */
export function readLastPlayed(source: string): string | null {
  const entry = readJson(LAST_PLAYED_STORE_KEY)[source];
  return typeof entry === "string" && entry ? entry : null;
}

export function writeLastPlayed(source: string, trackUrl: string): void {
  if (!source || !trackUrl) return;
  const store = readJson(LAST_PLAYED_STORE_KEY);
  store[source] = trackUrl;
  writeJson(LAST_PLAYED_STORE_KEY, store);
}

export function clearLastPlayed(source: string): void {
  const store = readJson(LAST_PLAYED_STORE_KEY);
  if (!(source in store)) return;
  delete store[source];
  writeJson(LAST_PLAYED_STORE_KEY, store);
}
