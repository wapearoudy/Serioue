// Development harness for "coming back does not lose your place".
//
// Mounts the real App — sidebar, list, reader, panels and all — against a
// backend whose categories are long enough to scroll, so returning from an
// article can be measured rather than argued about. Opened at
// /reader-return-preview.html while `pnpm dev` runs; never bundled into a
// release.

import "./dev-tauri-stub";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import type { ArticleItem, Category, Settings, SourceSummary } from "./api";
import "./styles.css";

const SETTINGS: Settings = {
  concurrent_checks: true,
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
    category_count: 3,
    has_search: false,
    js_enabled: false,
  };
}

const SOURCES = [source("alpha", "甲源"), source("beta", "乙源")];

const CATEGORIES: Category[] = [
  { name: "全部", url: "/demo/all", row: 0, paged: false },
  { name: "玄幻", url: "/demo/xh", row: 0, paged: false },
  { name: "都市", url: "/demo/ds", row: 0, paged: false },
];

/** Long enough that the list really scrolls, and identical per category so a
 *  restored offset can be compared against a known height. */
function itemsFor(url: string): ArticleItem[] {
  return Array.from({ length: 60 }, (_, i) => ({
    title: `${url.split("/").pop()} 第 ${i + 1} 篇`,
    link: `https://demo.local/${url.replace(/\W/g, "")}/${i}`,
    image: "",
    date: "2024-01-01",
    kind: "novel",
  }));
}

function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "list_sources":
        return SOURCES;
      case "get_source": {
        const id = String(args.id ?? "alpha");
        return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
      }
      case "stats":
        return {
          sources: 2,
          enabled: 2,
          favorites: 0,
          collections: 1,
          history: 1,
          checked: 0,
          working: 0,
        };
      case "categories":
        return { source: SOURCES.find((s) => s.id === args.id) ?? SOURCES[0], categories: CATEGORIES };
      case "load_page": {
        const a = args.args as { url?: string | null } | undefined;
        const url = a?.url ?? "/demo/all";
        return { items: itemsFor(url), next: null, final_url: url };
      }
      case "load_article": {
        const url = String(args.url ?? "");
        const text = Array.from({ length: 12 }, (_, i) => `正文第 ${i + 1} 段。`).join("\n");
        return {
          title: "示例文章",
          final_url: url,
          html: `<p>${text.replace(/\n/g, "</p><p>")}</p>`,
          text,
          media: [],
          audio: [],
        };
      }
      case "list_history":
        return [];
      case "list_shelf":
        return [];
      case "list_highlights":
        return [];
      case "list_collections":
        return [];
      case "get_settings":
        return SETTINGS;
      case "get_progress":
        return 0;
      case "get_progress_many":
        return {};
      case "save_progress":
        return null;
      case "continue_reading":
        return [];
      case "data_dir":
        return "C:\\data";
      case "repo_base":
        return "https://www.yck2026.fun";
      case "repo_index":
        return [];
      case "current_version":
        return "0.1.0";
      // The dev stub has no event plugin; App subscribes to update events on
      // mount, and an unhandled throw there shows up as a page error that has
      // nothing to do with what this harness is measuring.
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