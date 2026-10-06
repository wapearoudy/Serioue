// Development harness for the article list.
//
// Mounts the real ArticleList against a backend that can be told, from the URL,
// to answer slowly or to fail — the two situations the list has to survive.
// Opened at /reader-list-preview.html while `pnpm dev` runs; never bundled into
// a release.
//
//   ?fail=all       every list request fails, so the retry path can be exercised
//   ?fail=2         the first N list requests fail, so a retry can succeed.
//                   Two rather than one because React's StrictMode mounts effects
//                   twice in development, and the budget has to survive that to
//                   be a fair test of the retry rather than of the double mount.
//   ?slow=600       delay every response, so a category switch can be watched
//   ?searchFails=1  searching fails, so the search error path can be exercised
//
// `window.__listProbe` counts the requests that were actually issued, which is
// how a test tells "the retry fired" from "the button was pressed".

import "./dev-tauri-stub";
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArticleList } from "./components/ArticleList";
import type { ArticleItem, Category } from "./api";
import "./styles.css";

const params = new URLSearchParams(location.search);
const FAIL_PARAM = params.get("fail");
const FAIL_BUDGET = FAIL_PARAM && FAIL_PARAM !== "all" ? Number(FAIL_PARAM) || 0 : 0;
const FAIL_ALWAYS = FAIL_PARAM === "all";
const SEARCH_FAILS = params.get("searchFails") === "1";
const SLOW = Number(params.get("slow")) || 0;

type Probe = { requests: number; searchRequests: number; failures: number };
const probe: Probe = { requests: 0, searchRequests: 0, failures: 0 };
(window as unknown as { __listProbe: Probe }).__listProbe = probe;

const CATEGORIES: Category[] = [
  { name: "全部", url: "/demo/list/all", row: 0, paged: false },
  { name: "玄幻", url: "/demo/list/xuanhuan", row: 0, paged: false },
  { name: "都市", url: "/demo/list/dushi", row: 0, paged: false },
];

const ITEMS: Record<string, Array<Record<string, string>>> = {
  "/demo/list/all": [
    { title: "第一章 · 开端", link: "https://demo.local/1", image: "", date: "2024-01-01", kind: "novel" },
    { title: "第二章 · 转折", link: "https://demo.local/2", image: "", date: "2024-01-02", kind: "novel" },
    { title: "第三章 · 收束", link: "https://demo.local/3", image: "", date: "2024-01-03", kind: "novel" },
  ],
  "/demo/list/xuanhuan": [
    { title: "山海经 · 第一卷", link: "https://demo.local/y1", image: "", date: "2024-02-01", kind: "novel" },
    { title: "山海经 · 第二卷", link: "https://demo.local/y2", image: "", date: "2024-02-02", kind: "novel" },
    { title: "山海经 · 第三卷", link: "https://demo.local/y3", image: "", date: "2024-02-03", kind: "novel" },
    { title: "山海经 · 第四卷", link: "https://demo.local/y4", image: "", date: "2024-02-04", kind: "novel" },
  ],
  "/demo/list/dushi": [
    { title: "在人间", link: "https://demo.local/d1", image: "", date: "2024-03-01", kind: "novel" },
  ],
};

// Search answers with one obviously different entry, so a test can tell search
// results from the category listing without counting.
const SEARCH_HIT = [
  { title: "搜索命中 · 山海经", link: "https://demo.local/search-hit", image: "", date: "2024-04-01", kind: "novel" },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function respond<T>(value: T): Promise<T> {
  if (SLOW) await wait(SLOW);
  return value;
}

function shouldFail(): boolean {
  if (FAIL_ALWAYS) return true;
  if (FAIL_BUDGET > 0) {
    probe.failures += 1;
    return probe.failures <= FAIL_BUDGET;
  }
  return false;
}

/** Replace the dev stub's handlers with ones this harness can steer. */
function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "load_page") {
      probe.requests += 1;
      const a = args.args as { url?: string; next?: string | null } | undefined;
      const url = a?.url ?? "";
      if (shouldFail()) {
        await wait(SLOW);
        throw new Error(`HTTP 502 · 源暂时不可达（${url || "首页"}）`);
      }
      if (a?.next) {
        // The second page, so 「加载更多」 has something to do.
        return respond({
          items: [
            { title: `更多 · ${url}`, link: `https://demo.local/more-${probe.requests}`, image: "", date: "2024-05-01", kind: "novel" },
          ],
          next: null,
          final_url: url,
        });
      }
      const items = ITEMS[url] ?? [];
      return respond({ items, next: null, final_url: url || "/demo/list/all" });
    }
    if (cmd === "search_source") {
      probe.searchRequests += 1;
      if (SEARCH_FAILS) {
        await wait(SLOW);
        throw new Error("搜索接口 503");
      }
      // A term the harness treats as "nothing matches", so the empty search
      // state is reachable without inventing a second backend.
      const term = String(args.keyword ?? "");
      const items = term.includes("不存在") ? [] : SEARCH_HIT;
      return respond({ items, next: null, final_url: term });
    }
    return base(cmd, args);
  };
}

installHarness();

function Preview() {
  const [opened, setOpened] = useState<ArticleItem | null>(null);
  const [counts, setCounts] = useState(0);

  const onOpen = useCallback((item: ArticleItem) => setOpened(item), []);

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        <div className="main-head">
          <div className="main-title">
            列表体验预览
            <span>演示小说源 · 已打开 {opened ? opened.title : "无"} · 上报 {counts} 条</span>
          </div>
          <span className="spacer" />
          <button className="ghost" onClick={() => setOpened(null)}>
            关闭
          </button>
        </div>
        {opened && (
          <div className="banner" data-opened="1">
            打开了：{opened.title}
          </div>
        )}
        <ArticleList
          sourceId="demo:novel"
          sourceName="演示小说源"
          categories={CATEGORIES}
          onOpen={onOpen}
          onItemsChange={(items) => setCounts(items.length)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
