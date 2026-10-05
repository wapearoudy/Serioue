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

const HANDLERS: Record<string, Handler> = {
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
    writeStore({ ...store, progress });
  },
  get_settings: () => readStore().settings ?? {},
  set_settings: (args) => {
    writeStore({ ...readStore(), settings: args.settings });
  },
  current_version: () => "0.1.0",
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