// Development harness for "the reader finds out their rule is dead".
//
// Mounts the real ArticleList against a stub that can be told what diagnosis to
// hand back for the first load and what to hand back afterwards — so the test can
// prove both that the warning appears and that it does not stick around once it
// no longer applies.
//
// Opened at /reader-diagnosis-preview.html while `pnpm dev` runs; never bundled
// into a release.

import "./dev-tauri-stub";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ArticleList } from "./components/ArticleList";
import type { ArticleItem, Category } from "./api";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
/** The diagnosis for the first category; an empty parameter means "none, ever". */
const firstDiagnosis = params.get("diagnosis") ?? "";

const CATEGORIES: Category[] = [
  { name: "全部", url: "/demo/all", row: 0, paged: false },
  { name: "玄幻", url: "/demo/xh", row: 0, paged: false },
];

function itemsFor(url: string): ArticleItem[] {
  return Array.from({ length: 12 }, (_, i) => ({
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
      case "load_page": {
        const a = args.args as { url?: string | null } | undefined;
        const url = a?.url ?? "/demo/all";
        const page: Record<string, unknown> = { items: itemsFor(url), next: null, final_url: url };
        // Keyed on the category, not on "the first call": StrictMode invokes mount
        // effects twice, so a call counter is spent before the reader sees
        // anything and the warning never appears at all.
        if (firstDiagnosis && url === "/demo/all") page.diagnosis = firstDiagnosis;
        return page;
      }
      case "search_source":
        return { items: itemsFor("/demo/search"), next: null, final_url: "/demo/search" };
      default:
        return base(cmd, args);
    }
  };
}

installHarness();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ArticleList
      sourceId="alpha"
      sourceName="甲源"
      categories={CATEGORIES}
      onOpen={() => {}}
    />
  </StrictMode>,
);
