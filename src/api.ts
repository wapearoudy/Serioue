import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types mirroring the Rust command signatures
// ---------------------------------------------------------------------------

export interface Health {
  ok: boolean;
  status: string;
  item_count: number;
  checked_at: number;
  sample: string;
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
}

export interface ArticleResponse {
  title: string;
  html: string;
  text: string;
  final_url: string;
  media: string[];
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

export interface HistoryEntry {
  id: string;
  source_id: string;
  title: string;
  url: string;
  source_name: string;
  viewed_at: number;
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

export interface CheckProgress {
  done: number;
  total: number;
  current: string;
}

export interface CheckSummary {
  total: number;
  ok: number;
  failed: number;
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

  checkSource: (id: string) => invoke<Health>("check_source", { id }),

  checkAll: (ids?: string[]) =>
    invoke<CheckSummary>("check_all", { ids: ids ?? null }),

  listHistory: (limit?: number) => invoke<HistoryEntry[]>("list_history", { limit: limit ?? null }),

  clearHistory: () => invoke<void>("clear_history"),

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
  onCheckProgress: (cb: (p: CheckProgress) => void): Promise<UnlistenFn> =>
    listen<CheckProgress>("check-progress", (e) => cb(e.payload)),

  onPageLoaded: (cb: (p: ArticlePage) => void): Promise<UnlistenFn> =>
    listen<ArticlePage>("page-loaded", (e) => cb(e.payload)),

  /** Emitted at startup when a newer release exists. */
  onUpdateAvailable: (cb: (info: UpdateInfo) => void): Promise<UnlistenFn> =>
    listen<UpdateInfo>("update-available", (e) => cb(e.payload)),

  /** Emitted repeatedly while an update downloads. */
  onUpdateProgress: (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>("update-progress", (e) => cb(e.payload)),
};

/** Strip the backend's error prefix from an update body. */
export function updateError(body: string | null): string | null {
  if (!body) return null;
  if (body.startsWith("__error__")) return body.slice("__error__".length);
  if (body.startsWith("__offline__")) return "无法连接 GitHub，请检查网络后重试。";
  return null;
}

/** Tauri rejects with a plain string; normalise it for display. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}