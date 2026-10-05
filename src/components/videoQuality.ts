// Remembering the chosen quality, per entry.
//
// These are plain functions over `localStorage`, with no React and no video
// element involved, so they live here rather than inside `VideoPlayer.tsx`:
// keeping a non-component export out of a component module is what lets a
// preview page hot-reload, and it lets a settings panel offer "forget every
// remembered quality" without importing a player it has no use for.

/** Where the remembered quality per entry is kept. */
export const QUALITY_STORE_KEY = "serious.videoQuality.v1";

/** Auto. A remembered -1 means "let the player choose", which is a real choice. */
export const AUTO_LEVEL = -1;

/**
 * The identity a quality choice belongs to.
 *
 * The entry key is preferred over the stream URL: a series plays different URLs
 * for the same episode depending on the page it was found on, and a viewer who
 * asks for 480p on one episode means it on the next visit, not once per mirror.
 * Falling back to the URL keeps direct links working.
 */
export function qualityMemoryKey(resumeKey: string | undefined, src: string): string {
  return resumeKey && resumeKey.trim() ? resumeKey : src;
}

/** The whole map, or `{}` when storage is unavailable or corrupt. */
function readQualityStore(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(QUALITY_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    // Private mode and a quota-exceeded write both land here. Losing the memory
    // is survivable; breaking the player over it is not.
    return {};
  }
}

/** The remembered level for one entry, or null when nothing was remembered. */
export function readQualityMemory(key: string): number | null {
  const value = readQualityStore()[key];
  return value === undefined ? null : value;
}

/** Remember a level (`AUTO_LEVEL` means 自动) for one entry. */
export function writeQualityMemory(key: string, level: number): void {
  try {
    const store = readQualityStore();
    store[key] = level;
    window.localStorage.setItem(QUALITY_STORE_KEY, JSON.stringify(store));
  } catch {
    /* not fatal: the choice still applies to this session */
  }
}

/**
 * Forget remembered quality — for one entry, or for every entry when no key is
 * given. The quality menu's 「清除画质记忆」 uses the single-entry form; a reset
 * button in settings can use the whole-store one.
 */
export function clearQualityMemory(key?: string): void {
  try {
    if (key === undefined) {
      window.localStorage.removeItem(QUALITY_STORE_KEY);
      return;
    }
    const store = readQualityStore();
    if (!(key in store)) return;
    delete store[key];
    window.localStorage.setItem(QUALITY_STORE_KEY, JSON.stringify(store));
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

/**
 * How many entries are remembered — a settings panel shows this rather than
 * making the user guess whether there is anything to clear.
 */
export function rememberedQualityCount(): number {
  return Object.keys(readQualityStore()).length;
}