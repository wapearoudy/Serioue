import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types mirroring the Rust command signatures
// ---------------------------------------------------------------------------

/** Outcome of one verification stage. */
export type StageState = "ok" | "warn" | "fail" | "skip";

export interface StageResult {
  key: string;
  label: string;
  state: StageState;
  detail: string;
  ms: number;
}

export interface Health {
  ok: boolean;
  status: string;
  item_count: number;
  checked_at: number;
  sample: string;
  /** Absent for sources checked before source verification existed. */
  stages: StageResult[];
  duration_ms: number;
}

export interface SourceSummary {
  id: string;
  name: string;
  url: string;
  group: string;
  enabled: boolean;
  favorite: boolean;
  collection: string;
  health: Health | null;
  note: string;
  category_count: number;
  has_search: boolean;
  js_enabled: boolean;
}

export interface Category {
  name: string;
  url: string;
  row: number;
  paged: boolean;
}

export interface ArticleItem {
  title: string;
  link: string;
  image: string;
  date: string;
  kind: string;
}

export interface ArticlePage {
  items: ArticleItem[];
  next: string | null;
  final_url: string;
  /**
   * A sentence in plain Chinese explaining that this source's rules no longer
   * match the site, when the engine had to fall back to the page's raw links.
   *
   * Optional because the backend only sends it when it has something to say —
   * an absent field means the rules worked, not that the field was lost.
   */
  diagnosis?: string | null;
}

export interface ArticleResponse {
  title: string;
  html: string;
  text: string;
  final_url: string;
  media: string[];
  /** Audio files on the page, for the music player. */
  audio: string[];
}

export interface CategoriesResponse {
  source: SourceSummary;
  categories: Category[];
}

export interface ImportResult {
  added: number;
  skipped: number;
  collection: string;
}

export interface RepoCollection {
  id: string;
  title: string;
  author: string;
  source_count: number;
  downloads: number;
  date: string;
  page_url: string;
  json_url: string;
}

/** One shelved list, with how far through it the reader has got. */
export interface ShelfProgress {
  entry: ShelfEntry;
  /** Chapters counted on the first page; `null` when the list could not be read. */
  total: number | null;
  finished: number;
  partial: number;
  /** Why the numbers are missing, or a caveat about them. */
  note: string;
}

export interface Highlight {
  id: string;
  url: string;
  source_id: string;
  title: string;
  source_name: string;
  text: string;
  note: string;
  created_at: number;
}

export interface ShelfEntry {
  id: string;
  source_id: string;
  source_name: string;
  category: string;
  title: string;
  url: string;
  kind: string;
  added_at: number;
}

/** The id a shelf entry gets, so the list header can tell whether it is saved. */
export function shelfId(sourceId: string, category: string): string {
  return `${sourceId}::${category}`;
}

export interface HistoryEntry {
  id: string;
  source_id: string;
  title: string;
  url: string;
  source_name: string;
  viewed_at: number;
}

/** A half-read article offered back to the user. */
export interface ContinueEntry {
  url: string;
  title: string;
  source_id: string;
  source_name: string;
  viewed_at: number;
  progress: number;
}

export interface Collection {
  name: string;
  url: string;
  source_url: string;
  author: string;
  count: number;
  added_at: number;
}

export interface Settings {
  concurrent_checks: boolean;
  page_size: number;
  cache_enabled: boolean;
  repo_base: string;
  user_agent: string;
  // --- Reader appearance ---
  reader_font_size: number;
  reader_line_height: number;
  /** "" = system font, "serif", "sans". */
  reader_font: string;
  /** "dark" | "light" | "sepia" | "green". */
  reader_theme: string;
  /** Column width in px; 0 means full width. */
  reader_width: number;
  /** Volume remembered across launches, 0-1. */
  player_volume: number;
  /** Playback speed remembered across launches. */
  player_rate: number;
  /** Render script-built pages when the ordinary fetch yields nothing. */
  /**
   * Render script-built pages when the ordinary fetch yields nothing.
   *
   * Opt-in: the mechanism works, but measuring it over real sources showed no
   * gain for its cost.
   */
  render_js: boolean;
}

export interface Stats {
  sources: number;
  enabled: number;
  favorites: number;
  collections: number;
  history: number;
  checked: number;
  working: number;
}

/** One period's totals: how many articles, and how long. */
export interface PeriodStats {
  articles: number;
  minutes: number;
}

/** Articles read from one source, all time. */
export interface SourceCount {
  source_id: string;
  source_name: string;
  articles: number;
}

/**
 * How much the reader has read, derived entirely from local records.
 *
 * Minutes are inferred from the gap between opening an article and last saving
 * a reading position, capped per article — see `reading_stats.rs`, which is
 * where the cap and its reason live.
 */
export interface ReadingStats {
  today: PeriodStats;
  week: PeriodStats;
  all: PeriodStats;
  /** Busiest sources first. */
  by_source: SourceCount[];
  /** False when nothing has been read yet, so the UI can say so. */
  has_data: boolean;
}

/** Which sources a batch verification should cover. */
export type CheckScope = "all" | "failed" | "unchecked" | "stale";

export interface CheckEvent {
  done: number;
  total: number;
  current: string;
  source_id: string;
  name: string;
  health: Health;
}

export interface CheckSummary {
  total: number;
  ok: number;
  warn: number;
  failed: number;
  cancelled: boolean;
}

/** Result of an update check. */
export interface UpdateInfo {
  available: boolean;
  version: string;
  current_version: string;
  date: string | null;
  /**
   * Release notes. The backend prefixes errors with `__error__` or
   * `__offline__` so the UI can distinguish them from real notes.
   */
  body: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  percent: number | null;
}

export interface SourcePatch {
  enabled?: boolean;
  favorite?: boolean;
  custom_order?: number;
  note?: string;
}

export interface LoadPageArgs {
  id: string;
  url?: string | null;
  page?: number | null;
  next?: string | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const api = {
  listSources: (filter?: string) =>
    invoke<SourceSummary[]>("list_sources", { filter: filter ?? null }),

  getSource: (id: string) => invoke<SourceSummary>("get_source", { id }),

  updateSource: (id: string, patch: SourcePatch) =>
    invoke<void>("update_source", { id, patch }),

  removeSources: (ids: string[]) => invoke<number>("remove_sources", { ids }),

  importFromUrl: (url: string, name?: string) =>
    invoke<ImportResult>("import_from_url", { url, name: name ?? null }),

  importFromText: (text: string, name?: string) =>
    invoke<ImportResult>("import_from_text", { text, name: name ?? null }),

  repoBase: () => invoke<string>("repo_base"),

  repoIndex: (page?: number) => invoke<RepoCollection[]>("repo_index", { page: page ?? null }),

  categories: (id: string) => invoke<CategoriesResponse>("categories", { id }),

  loadPage: (args: LoadPageArgs) => invoke<ArticlePage>("load_page", { args }),

  loadArticle: (id: string, url: string, title?: string) =>
    invoke<ArticleResponse>("load_article", { id, url, title: title ?? null }),

  searchSource: (id: string, keyword: string) =>
    invoke<ArticlePage>("search_source", { id, keyword }),

  /** Verify one source through every stage and store the report. */
  checkSource: (id: string) => invoke<Health>("check_source", { id }),

  /** Verify many sources, streaming `CheckEvent`s as each one finishes. */
  checkAll: (opts: { ids?: string[]; scope?: CheckScope } = {}) =>
    invoke<CheckSummary>("check_all", {
      ids: opts.ids ?? null,
      scope: opts.scope ?? null,
    }),

  /** Ask a running `checkAll` to stop after the sources in flight. */
  cancelCheck: () => invoke<void>("cancel_check"),

  listHistory: (limit?: number) => invoke<HistoryEntry[]>("list_history", { limit: limit ?? null }),

  clearHistory: () => invoke<void>("clear_history"),

  listShelf: () => invoke<ShelfEntry[]>("list_shelf"),

  addShelf: (entry: ShelfEntry) => invoke<ShelfEntry>("add_shelf", { entry }),

  removeShelf: (id: string) => invoke<void>("remove_shelf", { id }),

  /** How far through each shelved list the reader has got. */
  shelfProgress: () => invoke<ShelfProgress[]>("shelf_progress"),

  listHighlights: () => invoke<Highlight[]>("list_highlights"),

  highlightsFor: (url: string) => invoke<Highlight[]>("highlights_for", { url }),

  addHighlight: (h: Highlight) => invoke<Highlight>("add_highlight", { highlight: h }),

  removeHighlight: (id: string) => invoke<void>("remove_highlight", { id }),

  /**
   * Save or clear the note on one highlight.
   *
   * A dedicated command, not `addHighlight`: highlighting the same passage twice
   * is de-duplicated by (article, text) and returns the stored record untouched,
   * so re-adding with a new note would silently restore the old one. `null` means
   * "no note" — the highlight itself stays.
   */
  updateHighlightNote: (id: string, note: string | null) =>
    invoke<void>("update_highlight_note", { id, note }),

  /** Articles started but not finished, newest first. */
  continueReading: () => invoke<ContinueEntry[]>("continue_reading"),

  /** How far through an article the reader had got (0-1). */
  getProgress: (url: string) => invoke<number>("get_progress", { url }),

  saveProgress: (url: string, ratio: number) =>
    invoke<void>("save_progress", { url, ratio }),

  /** Reading positions for a whole chapter list, keyed by URL. */
  getProgressMany: (urls: string[]) =>
    invoke<Record<string, number>>("get_progress_many", { urls }),

  /** How much has been read today, this week and all time. */
  readingStats: () => invoke<ReadingStats>("reading_stats"),

  /**
   * Fetch a text file the webview cannot fetch itself (CORS). Used for `.lrc`
   * lyrics, which live on the music host.
   */
  fetchText: (url: string) => invoke<string>("fetch_text", { url }),

  listCollections: () => invoke<Collection[]>("list_collections"),

  removeCollection: (url: string) => invoke<void>("remove_collection", { url }),

  getSettings: () => invoke<Settings>("get_settings"),

  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),

  clearCache: () => invoke<number>("clear_cache"),

  clearCookies: () => invoke<void>("clear_cookies"),

  stats: () => invoke<Stats>("stats"),

  dataDir: () => invoke<string>("data_dir"),

  checkUpdate: () => invoke<UpdateInfo>("check_update"),

  installUpdate: () => invoke<void>("install_update"),

  currentVersion: () => invoke<string>("current_version"),
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const events = {
  onCheckProgress: (cb: (p: CheckEvent) => void): Promise<UnlistenFn> =>
    listen<CheckEvent>("check-progress", (e) => cb(e.payload)),

  onPageLoaded: (cb: (p: ArticlePage) => void): Promise<UnlistenFn> =>
    listen<ArticlePage>("page-loaded", (e) => cb(e.payload)),

  /** Emitted at startup when a newer release exists. */
  onUpdateAvailable: (cb: (info: UpdateInfo) => void): Promise<UnlistenFn> =>
    listen<UpdateInfo>("update-available", (e) => cb(e.payload)),

  /** Emitted repeatedly while an update downloads. */
  onUpdateProgress: (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>("update-progress", (e) => cb(e.payload)),
};

/** The three non-error states the backend encodes into `body`. */
export type UpdateNotice = "offline" | "norelease" | "error";

/** The marker prefixes the backend puts in front of a non-notes body. */
const UPDATE_MARKERS = {
  offline: "__offline__",
  norelease: "__norelease__",
  error: "__error__",
} as const;

/** Which marker a release body carries, or `null` if it is real release notes. */
export function updateNotice(body: string | null): UpdateNotice | null {
  if (!body) return null;
  if (body.startsWith(UPDATE_MARKERS.offline)) return "offline";
  if (body.startsWith(UPDATE_MARKERS.norelease)) return "norelease";
  if (body.startsWith(UPDATE_MARKERS.error)) return "error";
  return null;
}

/**
 * Turn an update body into a sentence a user can act on.
 *
 * Always returns Chinese: the plugin's own strings ("Could not fetch a valid
 * release JSON from the remote") are developer-facing and mean nothing to the
 * person looking at the screen.
 */
export function updateError(body: string | null): string | null {
  switch (updateNotice(body)) {
    case "offline":
      return "无法连接 GitHub，请检查网络后重试。";
    case "norelease":
      return "还没有发布正式版本。GitHub 上尚未生成 latest.json，等第一个 Release 发布后即可自动更新。";
    case "error":
      return "检查更新时出错，请稍后再试。";
    default:
      return null;
  }
}

/** The raw plugin message behind {@link updateError}, kept for the tooltip. */
export function updateErrorDetail(body: string | null): string | null {
  const kind = updateNotice(body);
  if (!kind || !body) return null;
  return body.slice(UPDATE_MARKERS[kind].length);
}

/** Tauri rejects with a plain string; normalise it for display. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}