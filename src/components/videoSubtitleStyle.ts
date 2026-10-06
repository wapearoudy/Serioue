// Remembering how subtitles should look, per source.
//
// Same reasoning as the quality memory in `videoQuality.ts`: these are plain
// functions over `localStorage` with no React and no video element in them, so
// a settings panel can offer "forget the subtitle style" without importing the
// player.
//
// What is stored is the *viewer's* choice, never a detection result: whether a
// film needs big subtitles is a matter of taste and eyesight, not of the file.

/** Where the remembered subtitle appearance per source is kept. */
export const SUBTITLE_STYLE_STORE_KEY = "serious.videoSubtitleStyle.v1";

/** Subtitle sizes, smallest first. */
export const SUBTITLE_SIZES = ["small", "medium", "large", "huge"] as const;
export type SubtitleSize = (typeof SUBTITLE_SIZES)[number];

/** Where the caption sits on the picture. */
export const SUBTITLE_POSITIONS = ["top", "middle", "bottom"] as const;
export type SubtitlePosition = (typeof SUBTITLE_POSITIONS)[number];

export type SubtitleStyle = {
  size: SubtitleSize;
  position: SubtitlePosition;
  /** A translucent black plate behind the text. On by default: it is the floor
   *  of readability, not a preference. */
  background: boolean;
};

/**
 * A translucent black plate is the default on purpose.
 *
 * Captions over an arbitrary frame are unreadable without one — white text on a
 * white sky is not a style question. Someone who genuinely does not want it can
 * turn it off, but nobody should have to.
 */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  size: "medium",
  position: "bottom",
  background: true,
};

const isSize = (v: unknown): v is SubtitleSize =>
  typeof v === "string" && (SUBTITLE_SIZES as readonly string[]).includes(v);
const isPosition = (v: unknown): v is SubtitlePosition =>
  typeof v === "string" && (SUBTITLE_POSITIONS as readonly string[]).includes(v);

/** Coerce anything read out of storage into a usable style. */
export function normalizeSubtitleStyle(value: unknown): SubtitleStyle {
  if (!value || typeof value !== "object") return { ...DEFAULT_SUBTITLE_STYLE };
  const raw = value as Partial<SubtitleStyle>;
  return {
    size: isSize(raw.size) ? raw.size : DEFAULT_SUBTITLE_STYLE.size,
    position: isPosition(raw.position) ? raw.position : DEFAULT_SUBTITLE_STYLE.position,
    background:
      typeof raw.background === "boolean" ? raw.background : DEFAULT_SUBTITLE_STYLE.background,
  };
}

function readStyleStore(): Record<string, SubtitleStyle> {
  try {
    const raw = window.localStorage.getItem(SUBTITLE_STYLE_STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SubtitleStyle> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = normalizeSubtitleStyle(v);
    }
    return out;
  } catch {
    return {};
  }
}

function writeStyleStore(store: Record<string, SubtitleStyle>): void {
  try {
    window.localStorage.setItem(SUBTITLE_STYLE_STORE_KEY, JSON.stringify(store));
  } catch {
    /* the style still applies to this session */
  }
}

/**
 * The identity a subtitle style belongs to.
 *
 * Keyed by the source first, so one film's big captions do not become everyone's
 * — the whole point of remembering a choice per source.
 */
export function subtitleStyleKey(sourceId: string, entryKey = ""): string {
  return entryKey ? `${sourceId}::${entryKey}` : sourceId;
}

/** The remembered style for one source, or the default when it has none. */
export function readSubtitleStyle(key: string): SubtitleStyle {
  const value = readStyleStore()[key];
  return value ? { ...value } : { ...DEFAULT_SUBTITLE_STYLE };
}

/** Remember a style for one source. */
export function writeSubtitleStyle(key: string, style: SubtitleStyle): void {
  try {
    const store = readStyleStore();
    store[key] = normalizeSubtitleStyle(style);
    writeStyleStore(store);
  } catch {
    /* not fatal: the style still applies to this session */
  }
}

/** Forget one source's style, so it goes back to the default. */
export function clearSubtitleStyle(key: string): void {
  try {
    const store = readStyleStore();
    if (!(key in store)) return;
    delete store[key];
    writeStyleStore(store);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
}

/** How many sources have a remembered style — a settings panel shows this. */
export function rememberedSubtitleStyleCount(): number {
  return Object.keys(readStyleStore()).length;
}

/**
 * Whether the keyboard shortcuts are on.
 *
 * Global rather than per source: someone who turned shortcuts off meant it for
 * this player, not for one particular film.
 */
const SHORTCUTS_STORE_KEY = "serious.videoShortcuts.v1";

export function readShortcutsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORE_KEY);
    if (raw === null) return true;
    return raw !== "0";
  } catch {
    return true;
  }
}

export function writeShortcutsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SHORTCUTS_STORE_KEY, enabled ? "1" : "0");
  } catch {
    /* the choice still applies to this session */
  }
}

/**
 * Translate a style into the CSS a `<track>` element actually needs.
 *
 * Chromium exposes `::cue`, and its geometry properties are limited — a caption
 * cannot be nudged with margins the way a normal box can. So the *position* is
 * carried by where the player's own caption mirror is drawn, and the *size* and
 * *background* by `::cue` rules.
 */
export function subtitleCueStyle(style: SubtitleStyle): React.CSSProperties {
  const fontSize =
    style.size === "small" ? "16px" : style.size === "large" ? "30px" : style.size === "huge" ? "38px" : "22px";
  return {
    // `textShadow` rather than a background: ::cue accepts only colour properties,
    // so the plate is painted as a shadow, which every engine honours.
    ...(style.background
      ? { textShadow: "0 0 6px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.9)" }
      : {}),
    fontSize,
    lineHeight: 1.4,
  } as React.CSSProperties;
}