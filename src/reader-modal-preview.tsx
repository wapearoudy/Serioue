// Development harness for the import dialog.
//
// Mounts the real RepoBrowser behind a button that stands in for the app's own
// 「导入合集」, so the dialog can be driven with the keyboard: Escape, focus in,
// focus trapped, focus returned. Opened at /reader-modal-preview.html while
// `pnpm dev` runs; never bundled into a release.
//
//   ?repo=https://mirror.example   the configured repository base, so the
//                                  placeholder can be checked against it

import "./dev-tauri-stub";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { RepoBrowser } from "./components/RepoBrowser";
import type { RepoCollection } from "./api";
import "./styles.css";

const params = new URLSearchParams(location.search);
const REPO_BASE = params.get("repo") || "https://mirror.example";

const COLLECTIONS: RepoCollection[] = [
  {
    id: "c1",
    title: "演示合集一",
    author: "someone",
    source_count: 12,
    downloads: 340,
    date: "2024-05-01",
    page_url: "https://mirror.example/c/1",
    json_url: "https://mirror.example/c/1.json",
  },
  {
    id: "c2",
    title: "演示合集二",
    author: "other",
    source_count: 30,
    downloads: 120,
    date: "2024-05-02",
    page_url: "https://mirror.example/c/2",
    json_url: "https://mirror.example/c/2.json",
  },
  {
    id: "c3",
    title: "演示合集三",
    author: "third",
    source_count: 8,
    downloads: 55,
    date: "2024-05-03",
    page_url: "https://mirror.example/c/3",
    json_url: "https://mirror.example/c/3.json",
  },
];

function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "repo_index") return COLLECTIONS;
    if (cmd === "repo_base") return REPO_BASE;
    if (cmd === "import_from_url") return { added: 3, skipped: 1, collection: "演示" };
    return base(cmd, args);
  };
}

installHarness();

function Preview() {
  const [open, setOpen] = useState(false);
  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        <div className="main-head">
          <div className="main-title">导入弹层预览</div>
          <span className="spacer" />
          <button className="primary" data-open-repo onClick={() => setOpen(true)}>
            导入合集
          </button>
        </div>
        <div className="main-body" style={{ padding: 18 }}>
          <p style={{ color: "var(--text-dim)" }}>
            背景内容：焦点不应该跑到这里来。仓库地址由 ?repo= 决定，当前是 {REPO_BASE}。
          </p>
        </div>
        {open && <RepoBrowser onClose={() => setOpen(false)} onImported={() => {}} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);