// Capture what these sources actually serve, so a failure can be classified
// instead of guessed at.
//
// t1 found 8 sources where the browser render worked — the page came back with
// links — but the source's rules still matched nothing. That leaves exactly two
// explanations, and they call for opposite responses:
//
//   * the rule points at classes the site no longer serves  → upstream redesign
//   * the classes are there, with content, and our parser misses them → our bug
//
// Telling them apart needs the *rendered* DOM, because these sites serve an
// empty shell and build the list in the browser. So this captures, per source:
//
//   * the raw response (what the ordinary fetch sees)
//   * the rendered DOM (what a browser sees), N snapshots so a source that only
//     works sometimes can be recognised as intermittent instead of "fixed"
//
// plus the source's rules verbatim, so the comparison is rule-vs-page rather
// than rule-vs-recollection.
//
// Run from the project root after `cargo build --release`:
//
//   node scripts/t8-capture.mjs
//
// Environment:
//   SERIOUS_T8_ATTEMPTS  snapshots per source (default 3)
//   SERIOUS_T8_URLS      collection ids (default 77,160)
//   SERIOUS_T8_NAMES     comma-separated source names
//   SERIOUS_T8_DIR       output dir (default test-results/t8-render)

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.env.SERIOUS_T8_DIR || "test-results/t8-render");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");

if (!existsSync(exe)) {
  console.error(`missing ${exe} — run: cargo build --release`);
  process.exit(1);
}

const ATTEMPTS = Number(process.env.SERIOUS_T8_ATTEMPTS || 3);
const COLLECTIONS = (process.env.SERIOUS_T8_URLS || "77,160")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((id) => (/^https?:/.test(id) ? id : `https://www.yck2026.fun/yuedu/rsss/json/id/${id}.json`));

// The eight class-B failures from the t1 report: the render produced links and
// the rules still matched none.
const NAMES = (process.env.SERIOUS_T8_NAMES ||
  "秀人集v16,秀人集a-v15,秀人集b-v3,爱情岛,美女网-秀人马甲,美图公社,影视森林,✡3A漫画®")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      const all = JSON.parse(await res.text());
      return Array.isArray(all) ? all : all.data ?? all.sources ?? [];
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// ---- the batch, with its rules kept verbatim ------------------------------
const batch = [];
const seen = new Set();
for (const url of COLLECTIONS) {
  const list = await getJson(url);
  for (const s of list) {
    const name = s.sourceName ?? s.source_name ?? "";
    if (!NAMES.includes(name) || seen.has(name)) continue;
    seen.add(name);
    batch.push({
      name,
      source_url: s.sourceUrl,
      sort_url: s.sortUrl ?? "",
      enable_js: !!s.enableJs,
      rule_articles: s.ruleArticles ?? "",
      rule_title: s.ruleTitle ?? "",
      rule_link: s.ruleLink ?? "",
      rule_content: (s.ruleContent ?? "").slice(0, 200),
      // The import payload is the collection entry untouched: it is parsed by
      // Legado field names (`sourceUrl`, `sortUrl`, `ruleArticles`, ...).
      // An earlier version of this file built its own object with snake_case
      // keys, the app then stored sources with no rules and no categories, and
      // every probe fell back to the site root — which would have produced a
      // confident verdict about the wrong URL.
      raw: s,
      from_collection: url,
    });
  }
}
const missing = NAMES.filter((n) => !batch.some((b) => b.name === n));
console.log(`batch: ${batch.length} source(s)${missing.length ? `, not found: ${missing.join(", ")}` : ""}`);

// Same category choice the audit makes: the site root if a category points at
// it, otherwise the first category that is not a search entry.
function pickCategory(cats, sourceUrl) {
  const resolved = (u) => {
    try {
      return new URL(u, sourceUrl).toString().replace(/\/+$/, "");
    } catch {
      return String(u).replace(/\/+$/, "");
    }
  };
  const siteRoot = String(sourceUrl).replace(/\/+$/, "");
  const byRoot = cats.find((c) => resolved(c.url) === siteRoot);
  if (byRoot) return { ...byRoot, url: resolved(byRoot.url) };
  const notSearch = cats.find((c) => !/搜索|搜|search|keyword/i.test(c.name));
  return notSearch ? { ...notSearch, url: resolved(notSearch.url) } : { name: "首页", url: resolved(siteRoot) };
}

/// Fill the page slot the way `browse::expand` does for the forms these
/// collections use. Probing a URL that still contains `{{page}}` asks the site
/// a question no reader ever asks, and the "page not found" it answers back
/// says nothing about the rule.
///
/// The category URL arrives percent-encoded (`%7B%7Bpage%7D%7D`), so it is
/// decoded first — otherwise the slot is invisible to the pattern and the probe
/// silently asks for a literal-brace URL.
function expandPage(template, page = 1) {
  const decoded = (() => {
    try {
      return decodeURIComponent(template);
    } catch {
      return template;
    }
  })();
  return decoded
    .replace(/\{\{\s*page\s*\}\}/gi, String(page))
    .replace(/\{\{\s*page\s*<\s*(\d+)\s*>\s*\}\}/gi, (_, off) => String(page + Number(off) - 1));
}

await mkdir(outDir, { recursive: true });
const profile = await mkdtemp(path.join(outDir, "profile-"));
const port = Number(process.env.SERIOUS_TEST_CDP_PORT || 19491);

const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERIOUS_DATA_DIR: profile,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "WebView2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
});

let diagnostics = "";
child.stderr.on("data", (c) => (diagnostics = (diagnostics + c.toString()).slice(-8000)));
child.stdout.on("data", (c) => (diagnostics = (diagnostics + c.toString()).slice(-8000)));

let browser;
let page;
let failed = false;
const invoke = (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

/// A file-safe slug that still says which source it came from.
const slug = (name, i) =>
  `${String(i + 1).padStart(2, "0")}-${name.replace(/[\\/:*?"<>|]/g, "_")}.html`;

try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`app exited early: ${child.exitCode}\n${diagnostics}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!browser) throw new Error("WebView2 remote debugging endpoint never came up");
  for (let i = 0; i < 120; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("no webview page was created");
  await page.waitForSelector(".app", { timeout: 20000 });
  console.log("  app is up");

  // Import the originals, so the category list comes from the real rules
  // rather than from anything reconstructed here.
  await invoke("import_from_text", { text: JSON.stringify(batch.map((b) => b.raw)), name: "t8" });
  const sources = await invoke("list_sources", { filter: null });
  const byName = new Map(sources.filter((s) => batch.some((b) => b.name === s.name)).map((s) => [s.name, s]));

  const manifest = [];
  for (const src of batch) {
    const stored = byName.get(src.name);
    const cats = stored ? (await invoke("categories", { id: stored.id })).categories ?? [] : [];
    const cat = pickCategory(cats, src.source_url);
    const probeUrl = expandPage(cat.url, 1);
    const entry = { ...src, probe_url: probeUrl, probe_category: cat.name, category_count: cats.length, snapshots: [] };
    delete entry.raw;
    console.log(`\n${src.name}  [${cat.name}] ${probeUrl}  (${cats.length} categor(ies))`);
    console.log(`  ruleArticles: ${src.rule_articles}`);

    for (let i = 0; i < ATTEMPTS; i++) {
      // Raw: what the ordinary fetch path sees.
      let rawLen = null;
      let rawError = null;
      try {
        const res = await fetch(probeUrl, { redirect: "follow" });
        const body = await res.text();
        rawLen = body.length;
        await writeFile(path.join(outDir, `${src.name.replace(/[\\/:*?"<>|]/g, "_")}-raw.html`), body, "utf8");
      } catch (e) {
        rawError = String(e);
      }

      // Rendered: what a browser sees. `render_html` is the command the engine
      // itself calls, so this is the same DOM the fallback would have parsed.
      let html = null;
      let renderError = null;
      try {
        html = await invoke("render_html", { url: probeUrl });
      } catch (e) {
        renderError = String(e);
      }
      if (html) {
        await writeFile(path.join(outDir, slug(src.name, i)), html, "utf8");
      }
      const linkCount = html ? (html.match(/<a\s/gi) || []).length : 0;
      entry.snapshots.push({
        attempt: i + 1,
        raw_len: rawLen,
        raw_error: rawError,
        rendered_len: html ? html.length : null,
        rendered_links: linkCount,
        render_error: renderError,
        file: html ? slug(src.name, i) : null,
      });
      console.log(
        `  #${i + 1}: raw ${rawLen ?? "ERR"} B · rendered ${html ? `${html.length} B / ${linkCount} <a>` : `ERR ${renderError}`}`,
      );
      // Offscreen windows are serialised behind one gate; no need to queue up
      // behind a sleep that the renderer already accounts for.
    }
    manifest.push(entry);
  }

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nwritten: ${path.join(outDir, "manifest.json")}`);
} catch (error) {
  failed = true;
  console.error("capture failed:", error.message);
  console.error(diagnostics.slice(-2500));
} finally {
  await browser?.close().catch(() => {});
  child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);