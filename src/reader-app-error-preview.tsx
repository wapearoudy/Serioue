// Development harness for "every failure says what to do about it".
//
// Mounts the real App against a stub that counts how many times each command was
// invoked and can be told to fail a chosen one. That is what makes the claim
// testable: a 「重试」 button is only honest if pressing it re-issues *that*
// request and leaves everything else alone.
//
// Opened at /reader-app-error-preview.html while `pnpm dev` runs; never bundled
// into a release.

import "./dev-tauri-stub";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import type { Category, Settings, SourceSummary } from "./api";
import "./styles.css";

const SETTINGS: Settings = {
  concurrent_checks: true,
  page_size: 60,
  cache_enabled: false,
  repo_base: "https://www.yck2026.fun",
  user_agent: "",
  reader_font_size: 17,
  reader_line_height: 180,
  reader_font: "",
  reader_theme: "dark",
  reader_width: 0,
  player_volume: 0.8,
  player_rate: 1,
  render_js: false,
};

function source(id: string, name: string): SourceSummary {
  return {
    id,
    name,
    url: `https://${id}.example`,
    group: "",
    enabled: true,
    favorite: false,
    collection: "演示",
    health: null,
    note: "",
    category_count: 2,
    has_search: false,
    js_enabled: false,
  };
}

const SOURCES = [source("alpha", "甲源"), source("beta", "乙源")];

const CATEGORIES: Category[] = [
  { name: "全部", url: "/demo/all", row: 0, paged: false },
  { name: "玄幻", url: "/demo/xh", row: 0, paged: false },
];

const items = Array.from({ length: 12 }, (_, i) => ({
  title: `第 ${i + 1} 篇`,
  link: `https://demo.local/${i}`,
  image: "",
  date: "2024-01-01",
  kind: "novel",
}));

/** Commands the test may make fail, via `?fail=list_sources,stats`. */
const failing = new Set(
  (new URLSearchParams(window.location.search).get("fail") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

declare global {
  interface Window {
    /** How many times each command has been invoked. */
    __calls?: Record<string, number>;
    /** Commands that should fail on their next invocation. */
    __fail?: Set<string>;
  }
}

window.__calls = {};
window.__fail = failing;

function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    window.__calls![cmd] = (window.__calls![cmd] ?? 0) + 1;
    if (window.__fail!.has(cmd)) {
      // A failure that reads like a real one: the app's own wording decides what
      // the reader is told, so the message must look like what it would in life.
      throw new Error(`${cmd} 暂时不可用`);
    }
    switch (cmd) {
      case "list_sources":
        return SOURCES;
      case "get_source":
        return SOURCES.find((s) => s.id === args.id) ?? SOURCES[0];
      case "stats":
        return { sources: 2, enabled: 2, favorites: 0, collections: 1, history: 0, checked: 0, working: 0 };
      case "categories":
        return { source: SOURCES.find((s) => s.id === args.id) ?? SOURCES[0], categories: CATEGORIES };
      case "load_page":
        return { items, next: null, final_url: String(args.url ?? "/demo/all") };
      case "get_settings":
        return SETTINGS;
      case "list_history":
      case "list_shelf":
      case "list_highlights":
      case "list_collections":
      case "continue_reading":
        return [];
      case "current_version":
        return "0.1.2";
      case "plugin:event|listen":
      case "plugin:event|unlisten":
        return null;
      default:
        return base(cmd, args);
    }
  };
}

installHarness();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
