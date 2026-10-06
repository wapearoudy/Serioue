// Development-only stand-in for Tauri's IPC bridge.
//
// The preview pages run in a plain browser, so `invoke` has nothing to call.
// This installs a minimal `window.__TAURI_INTERNALS__` backed by
// localStorage, which means state survives a page reload — that is what lets
// the reader and video resume behaviour be tested honestly.
//
// Never imported by the app itself; the preview entry points import it first.

type Handler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

const STORE_KEY = "serious-dev-store";

function readStore(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeStore(next: Record<string, unknown>) {
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
}

/** Longest any single article may claim, matching `reading_stats.rs`. */
const MAX_ARTICLE_SECS = 30 * 60;

/** Local calendar day of a timestamp, as `YYYY-MM-DD`. */
function localDay(secs: number): string {
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Monday of the week containing a local day. */
function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  // getDay() is 0 on Sunday; shift so Monday is the first day of the week.
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000);
}

/**
 * Reading statistics from stored records.
 *
 * Mirrors `reading_stats::compute`: articles counted on the day they were
 * opened, minutes inferred from the gap between opening an article and its last
 * saved position, capped per article, and split across midnight so neither day
 * is credited with the other's reading.
 */
function computeReadingStats(
  history: Array<Record<string, unknown>>,
  progress: Record<string, number>,
  stamps: Record<string, number>,
) {
  const now = Math.floor(Date.now() / 1000);
  const today = localDay(now);
  const monday = weekStart(today);

  const secondsByDay = new Map<string, number>();
  const articlesByDay = new Map<string, number>();
  const bySource = new Map<string, { source_id: string; source_name: string; articles: number }>();
  let total = 0;

  for (const entry of history) {
    const viewedAt = Number(entry.viewed_at) || 0;
    const url = String(entry.url ?? "");
    const day = localDay(viewedAt);
    articlesByDay.set(day, (articlesByDay.get(day) ?? 0) + 1);

    const sourceId = String(entry.source_id ?? "");
    const sourceName = String(entry.source_name ?? "");
    const key = sourceId || sourceName;
    const bucket = bySource.get(key) ?? { source_id: sourceId, source_name: sourceName, articles: 0 };
    bucket.articles += 1;
    bySource.set(key, bucket);

    if (!(url in progress)) continue;
    const saved = Number(stamps[url]) || 0;
    const start = Math.min(viewedAt, saved);
    const end = Math.max(viewedAt, saved);
    if (end <= start) continue;
    let remaining = Math.min(end - start, MAX_ARTICLE_SECS);
    let cursor = start;
    let cursorDay = localDay(start);
    while (remaining > 0) {
      const midnight = new Date(cursorDay + "T00:00:00");
      midnight.setDate(midnight.getDate() + 1);
      const boundary = Math.floor(midnight.getTime() / 1000);
      const take = boundary > cursor ? Math.min(boundary - cursor, remaining) : remaining;
      secondsByDay.set(cursorDay, (secondsByDay.get(cursorDay) ?? 0) + take);
      total += take;
      remaining -= take;
      cursor += take;
      cursorDay = localDay(cursor);
    }
  }

  const inWeek = (day: string) => day >= monday && day <= today;
  const sumDays = (m: Map<string, number>, want: (d: string) => boolean) => {
    let n = 0;
    for (const [d, v] of m) if (want(d)) n += v;
    return n;
  };

  return {
    today: {
      articles: articlesByDay.get(today) ?? 0,
      minutes: Math.floor((secondsByDay.get(today) ?? 0) / 60),
    },
    week: {
      articles: sumDays(articlesByDay, inWeek),
      minutes: Math.floor(sumDays(secondsByDay, inWeek) / 60),
    },
    all: { articles: history.length, minutes: Math.floor(total / 60) },
    by_source: Array.from(bySource.values()).sort(
      (a, b) => b.articles - a.articles || a.source_name.localeCompare(b.source_name),
    ),
    has_data: history.length > 0,
  };
}

const HANDLERS: Record<string, Handler> = {
  // A tiny in-page source: three categories, each with a couple of items. Used
  // by the shelf preview so the real ArticleList has something to render.
  load_page: (args) => {
    const a = args.args as { url?: string } | undefined;
    const url = a?.url ?? "";
    const byUrl: Record<string, Array<Record<string, string>>> = {
      "/demo/list/all": [
        { title: "第一章 · 开端", link: "https://demo.local/1", image: "", date: "2024-01-01", kind: "novel" },
        { title: "第二章 · 转折", link: "https://demo.local/2", image: "", date: "2024-01-02", kind: "novel" },
      ],
      "/demo/list/xuanhuan": [
        { title: "山海经 · 第一卷", link: "https://demo.local/y1", image: "", date: "2024-02-01", kind: "novel" },
      ],
      "/demo/list/dushi": [
        { title: "在人间", link: "https://demo.local/d1", image: "", date: "2024-03-01", kind: "novel" },
      ],
    };
    const items = byUrl[url] ?? [];
    return { items, next: null, final_url: url || "/demo/list/all" };
  },
  list_highlights: () => readStore().highlights ?? [],
  // --- reading statistics --------------------------------------------------
  // The same rules the Rust command applies, so a preview run shows what the
  // packaged app would show for the same records. The two implementations sit
  // side by side on purpose: when they disagree, this one is what has to change.
  list_history: () => readStore().history ?? [],
  reading_stats: () => {
    const store = readStore();
    // A recorded failure, so a test can check that the panel says something when
    // the backend cannot answer instead of turning forever.
    if (store.reading_stats_error) throw new Error(String(store.reading_stats_error));
    const history = ((store.history ?? []) as Array<Record<string, unknown>>).slice();
    const progress = (store.progress ?? {}) as Record<string, number>;
    const stamps = (store.progress_at ?? {}) as Record<string, number>;
    return computeReadingStats(history, progress, stamps);
  },
  highlights_for: (args) => {
    const all = (readStore().highlights ?? []) as Array<Record<string, unknown>>;
    return all
      .filter((h) => h.url === args.url)
      .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
  },
  add_highlight: (args) => {
    const store = readStore();
    const all = ((store.highlights ?? []) as Array<Record<string, unknown>>).slice();
    const h = args.highlight as Record<string, unknown>;
    const text = String(h.text ?? "").trim();
    if (!text) throw new Error("不能保存空的高亮");
    const existing = all.find((e) => e.url === h.url && e.text === text);
    if (existing) return existing;
    const now = Math.floor(Date.now() / 1000);
    const newest = all.reduce((m: number, e) => Math.max(m, Number(e.created_at) || 0), 0);
    // The Rust store mints an id only when the caller did not supply one, so a
    // record that is being put back (an undo) keeps its identity. Re-minting here
    // would make this stub disagree with the packaged app on exactly that.
    const saved = {
      ...h,
      id: h.id ? String(h.id) : `h${now}-${all.length}`,
      text,
      created_at: Math.max(now, newest + 1),
    };
    all.push(saved);
    writeStore({ ...store, highlights: all });
    return saved;
  },
  remove_highlight: (args) => {
    const store = readStore();
    const all = ((store.highlights ?? []) as Array<Record<string, unknown>>).filter(
      (h) => h.id !== args.id,
    );
    writeStore({ ...store, highlights: all });
  },
  update_highlight_note: (args) => {
    // Mirrors `Store::update_highlight_note` exactly: unknown id is an error
    // rather than a silent success, blank and null both mean "no note", and an
    // over-long note is refused. A preview that disagreed with the packaged app
    // here would make every note test meaningless.
    const store = readStore();
    const all = ((store.highlights ?? []) as Array<Record<string, unknown>>).slice();
    const at = all.findIndex((h) => h.id === args.id);
    if (at < 0) throw new Error("找不到这条划线");
    const raw = args.note == null ? "" : String(args.note).trim();
    if (raw.length > 2000) throw new Error("笔记过长");
    all[at] = { ...all[at], note: raw };
    writeStore({ ...store, highlights: all });
  },
  get_progress: (args) => {
    const store = readStore();
    const progress = (store.progress ?? {}) as Record<string, number>;
    return progress[String(args.url)] ?? 0;
  },
  get_progress_many: (args) => {
    const store = readStore();
    const progress = (store.progress ?? {}) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const url of (args.urls as string[]) ?? []) out[url] = progress[url] ?? 0;
    return out;
  },
  // A five-episode series, so the reader's episode picker has real siblings to
  // work with. `?ep=N` picks the episode.
  load_article: (args) => {
    const url = String(args.url ?? "");
    let ep = 1;
    try {
      ep = Number(new URL(url).searchParams.get("ep")) || 1;
    } catch {
      /* not a URL we can parse; episode 1 is a safe default */
    }
    return {
      title: `第 ${ep} 集 · 示例剧集`,
      final_url: url,
      html:
        `<video src="/demo/hls/master.m3u8" controls poster="/demo/poster.png"></video>` +
        `<track src="/demo/hls/subs.vtt" kind="subtitles" srclang="zh" label="中文" default>` +
        `<p>这是第 ${ep} 集的简介,用于检查正文与播放器是否同时显示。</p>`,
      text: `这是第 ${ep} 集的简介,用于检查正文与播放器是否同时显示。`,
      media: ["/demo/hls/master.m3u8"],
      audio: [],
    };
  },
  save_progress: (args) => {
    const store = readStore();
    const progress = { ...((store.progress ?? {}) as Record<string, number>) };
    progress[String(args.url)] = Number(args.ratio) || 0;
    // The backend stores when a position was saved as well as the ratio, and the
    // reading statistics need that timestamp. It lives in its own key so the
    // ratio map stays the plain numbers the shelf code already reads.
    const stamps = { ...((store.progress_at ?? {}) as Record<string, number>) };
    stamps[String(args.url)] = Math.floor(Date.now() / 1000);
    writeStore({ ...store, progress, progress_at: stamps });
  },
  get_settings: () => readStore().settings ?? {},
  set_settings: (args) => {
    writeStore({ ...readStore(), settings: args.settings });
  },
  list_shelf: () => readStore().shelf ?? [],
  shelf_progress: () => {
    // Same shape as the backend: chapters counted against saved positions.
    const store = readStore();
    const shelf = ((store.shelf ?? []) as Array<Record<string, unknown>>).slice();
    const progress = (store.progress ?? {}) as Record<string, number>;
    const lists: Record<string, string[]> = {
      全部: ["https://demo.local/1", "https://demo.local/2"],
      玄幻: ["https://demo.local/y1"],
      都市: ["https://demo.local/d1"],
    };
    return shelf.map((entry) => {
      const links = lists[String(entry.category)] ?? [];
      let finished = 0;
      let partial = 0;
      for (const link of links) {
        const at = progress[link] ?? 0;
        if (at >= 0.98) finished++;
        else if (at > 0.02) partial++;
      }
      return {
        entry,
        total: links.length,
        finished,
        partial,
        note: "",
      };
    });
  },
  add_shelf: (args) => {
    const store = readStore();
    const shelf = ((store.shelf ?? []) as Array<Record<string, unknown>>).slice();
    const entry = args.entry as Record<string, unknown>;
    const existing = shelf.find((e) => e.id === entry.id);
    if (existing) return existing;
    // Mirror the backend: the stamp is assigned here, stepping past the newest
    // one already saved, so same-second adds still come back newest-first.
    const now = Math.floor(Date.now() / 1000);
    const newest = shelf.reduce((m: number, e) => Math.max(m, Number(e.added_at) || 0), 0);
    const saved = { ...entry, added_at: Math.max(now, newest + 1) };
    shelf.push(saved);
    writeStore({ ...store, shelf });
    return saved;
  },
  remove_shelf: (args) => {
    const store = readStore();
    const shelf = ((store.shelf ?? []) as Array<Record<string, unknown>>).filter(
      (e) => e.id !== args.id,
    );
    writeStore({ ...store, shelf });
  },
  current_version: () => "0.1.0",
  // Lyrics in the browser preview. The packaged app goes through the backend,
  // which is where the CORS problem actually lives.
  fetch_text: async (args) => {
    const res = await fetch(String(args.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
};

export function installDevTauriStub() {
  const internals = {
    transformCallback: (cb: unknown) => cb,
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = HANDLERS[cmd];
      if (!handler) {
        throw new Error(`dev stub has no handler for "${cmd}"`);
      }
      return handler(args);
    },
    convertFileSrc: (p: string) => p,
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = internals;
}

installDevTauriStub();