// Render-fallback A/B: does turning the browser render on actually fix the
// script-built sources?
//
// The earlier answer ("zero benefit, 14 sources") was measured with
// `check_all`, which never touches the render path: `verify::probe_list` calls
// `fetch_ok` + `parse_list` directly, so `render_js` cannot change its verdict.
// This harness measures both sides instead:
//
//   * `load_page`  — the reader's real listing path, the only place
//                    `browse::should_render` is consulted.
//   * `check_source` — the verify/audit path, kept so the structural claim above
//                    is demonstrated rather than asserted.
//
// Rules of the experiment (they are the whole point):
//
//   * one app instance, one imported batch, both passes minutes apart;
//   * exactly one variable changes between passes: `settings.render_js`;
//   * the cache is cleared before every pass, or the second pass would read
//     the first pass's pages and mean nothing;
//   * pass order is off,on,off by default, so a drift in the sites themselves
//     shows up as off ≠ off rather than being attributed to rendering.
//
// Run from the project root after `cargo build --release`:
//
//   node scripts/render-ab.mjs
//
// Read the result from `test-results/render-ab.json` or this script's own log —
// never through a pipeline that closes early. `cargo test | Select-Object
// -First 12` kills the run at the twelfth line: the summary has already been
// printed by then, the assertions have not run, and what you read is a report
// nobody checked. Every pass here writes its rows to disk as it goes for the
// same reason.
//
// Environment:
//   SERIOUS_AB_NAMES   comma-separated source names to include (default: the
//                      twelve script-built failures from test-results/audit77.log)
//   SERIOUS_AB_URLS    comma-separated collection urls (default: 77,160)
//   SERIOUS_AB_PASSES  comma list of off/on flags (default: off,on,off)
//   SERIOUS_AB_OUT     output json path (default: test-results/render-ab.json)

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");

if (!existsSync(exe)) {
  console.error(`missing ${exe} — run: cargo build --release`);
  process.exit(1);
}

const COLLECTIONS = (process.env.SERIOUS_AB_URLS || "77,160")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((id) => (/^https?:/.test(id) ? id : `https://www.yck2026.fun/yuedu/rsss/json/id/${id}.json`));

// The rule-broken, script-render sources that the collection audits named:
// twelve from test-results/audit77.log and four from test-results/audit160.log.
const DEFAULT_NAMES = [
  // collection 77
  "美图公社",
  "秀人集b-v3",
  "秀人集a-v15",
  "爱情岛",
  "美女网-秀人马甲",
  "秀人集v16",
  "✡3A漫画®",
  "一程(一起开源发布页)(一键导入)",
  "黑料社区",
  "box+apk 蓝奏直链√",
  "📖乐播",
  "蔡萝莉",
  // collection 160
  "迅雷榜单",
  "百度榜单",
  "影视森林",
  "搜书论坛",
];
const NAMES = (process.env.SERIOUS_AB_NAMES || DEFAULT_NAMES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const PASSES = (process.env.SERIOUS_AB_PASSES || "off,on,off").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(root, process.env.SERIOUS_AB_OUT || "test-results/render-ab.json");

// ---- the batch under test -------------------------------------------------
const batch = [];
const seen = new Set();

/// The repository resets the occasional TLS connection; one retry is enough
/// and beats failing the whole run over a socket.
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

for (const url of COLLECTIONS) {
  const list = await getJson(url);
  let matched = 0;
  for (const s of list) {
    const name = s.sourceName ?? s.source_name ?? "";
    if (!NAMES.includes(name) || seen.has(name)) continue;
    seen.add(name);
    matched++;
    batch.push(s);
  }
  console.log(`  ${url}: ${list.length} source(s), ${matched} selected`);
}
if (batch.length === 0) {
  console.error("no source matched the name list — nothing to measure");
  process.exit(1);
}
console.log(`batch: ${batch.length} source(s) — ${batch.map((s) => s.sourceName).join(", ")}`);

// ---- launch the real app --------------------------------------------------
await mkdir(outDir, { recursive: true });
const profile = await mkdtemp(path.join(outDir, "render-ab-profile-"));
const port = Number(process.env.SERIOUS_TEST_CDP_PORT || 19489);

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
child.stderr.on("data", (c) => (diagnostics = (diagnostics + c.toString()).slice(-12000)));
child.stdout.on("data", (c) => (diagnostics = (diagnostics + c.toString()).slice(-12000)));

let browser;
let page;
let failed = false;
const results = { batch: batch.map((s) => s.sourceName), passes: [] };

const invoke = (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

/// Same category the audit probes: the site root if a category points at it,
/// otherwise the first category that is not a search entry.
function pickCategory(cats, sourceUrl) {
  const resolved = (u) => {
    try {
      return new URL(u, sourceUrl).toString().replace(/\/+$/, "");
    } catch {
      return String(u).replace(/\/+$/, "");
    }
  };
  const root = String(sourceUrl).replace(/\/+$/, "");
  const byRoot = cats.find((c) => resolved(c.url) === root);
  // Returned resolved: `load_page` resolves internally, but the render probe
  // takes the URL as given, and a relative one is not a url at all.
  if (byRoot) return { ...byRoot, url: resolved(byRoot.url) };
  const notSearch = cats.find((c) => !/搜索|搜|search|keyword/i.test(c.name));
  return notSearch ? { ...notSearch, url: resolved(notSearch.url) } : { name: "首页", url: resolved(sourceUrl) };
}

/// The audit's bucket rule, applied to a verify report.
function verifyBucket(health) {
  const fail = (k) => health.stages.find((s) => s.key === k && s.state === "fail");
  const stage = fail("homepage") ?? fail("list");
  if (stage) {
    const d = (stage.detail || "").toLowerCase();
    const transport = ["无法访问", "网络请求失败", "timed out", "超时", "dns", "connection"].some((m) => d.includes(m));
    return { bucket: transport ? "unreachable" : "degraded", reason: `${stage.label}: ${stage.detail}` };
  }
  const usable =
    health.item_count > 0 && !health.stages.some((s) => s.key === "list" && (s.detail || "").includes("没有链接"));
  if (usable) return { bucket: "working", reason: health.status };
  const first = health.stages.find((s) => s.state === "warn" || s.state === "fail");
  return {
    bucket: "rule-broken",
    reason: first ? `${first.label}: ${first.detail}` : health.status,
  };
}

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

  // One import, one batch, shared by every pass.
  await invoke("import_from_text", { text: JSON.stringify(batch), name: "render-ab" });
  const sources = await invoke("list_sources", { filter: null });
  const picked = new Map();
  for (const s of sources) if (batch.some((b) => (b.sourceName ?? "") === s.name)) picked.set(s.name, s);
  if (picked.size !== batch.length) {
    throw new Error(`imported ${picked.size} of ${batch.length}; names: ${[...picked.keys()].join(", ")}`);
  }
  console.log(`  imported ${picked.size} source(s)\n`);

  for (const flag of PASSES) {
    const render = flag === "on";
    console.log(`\n===== pass render_js=${render} =====`);

    // Clear before measuring, never after: pass N's pages must not be readable
    // by pass N+1. `clear_cache` only wipes the article directory; the cookie
    // jar and the `<js>` memo cache live in `clear_cookies`, and a pass that
    // inherited them would be reading pass N's answers.
    const cleared = await invoke("clear_cache", {});
    await invoke("clear_cookies", {});
    console.log(`  cache cleared: ${cleared} article(s), cookies and js cache dropped`);

    const settings = await invoke("get_settings", {});
    await invoke("set_settings", { settings: { ...settings, render_js: render } });

    const pass = { render_js: render, rows: [] };
    let working = 0;
    let broken = 0;

    for (const name of batch.map((s) => s.sourceName)) {
      const s = picked.get(name);
      const cats = await invoke("categories", { id: s.id });
      const cat = pickCategory(cats.categories ?? [], s.url ?? "");

      const t0 = Date.now();
      let listing = { items: [], error: null };
      try {
        const pageRes = await invoke("load_page", { args: { id: s.id, url: cat.url, page: 1, next: null } });
        listing = { items: pageRes.items ?? [], error: null };
      } catch (e) {
        listing = { items: [], error: String(e) };
      }
      const openable = listing.items.filter((i) => i.link && String(i.link).trim()).length;
      const listMs = Date.now() - t0;

      const t1 = Date.now();
      let health = null;
      let bucket = { bucket: "error", reason: "verify did not run" };
      try {
        health = await invoke("check_source", { id: s.id });
        bucket = verifyBucket(health);
      } catch (e) {
        bucket = { bucket: "error", reason: String(e) };
      }
      const verifyMs = Date.now() - t1;

      const works = openable > 0;
      if (works) working++;
      else broken++;

      const row = {
        name,
        url: s.url ?? s.source_url,
        category: cat.name,
        probe: cat.url,
        openable,
        items: listing.items.length,
        first: listing.items.slice(0, 2).map((i) => i.title),
        list_error: listing.error,
        list_ms: listMs,
        verify_bucket: bucket.bucket,
        verify_reason: bucket.reason,
        verify_ms: verifyMs,
        verify_status: health?.status ?? null,
        verify_items: health?.item_count ?? null,
      };
      pass.rows.push(row);
      console.log(
        `  ${works ? "OK  " : "FAIL"} ${name} — ${openable}/${listing.items.length} openable ` +
          `(verify: ${bucket.bucket}, ${listMs + verifyMs}ms)` +
          (row.list_error ? ` error=${row.list_error}` : ""),
      );
      if (!works) console.log(`        ${bucket.reason}`);
    }

    pass.working = working;
    pass.rule_broken = broken;
    results.passes.push(pass);
    console.log(`  => render_js=${render}: ${working} working / ${broken} not working of ${pass.rows.length}`);

    // ---- why the ones that stayed broken stayed broken --------------------
    // Asked straight after the render-on pass: the app has been observed losing
    // its webview mid-run, and this is the evidence that would be lost with it.
    if (render) {
      console.log("\n  -- why the still-broken ones failed (with rendering on) --");
      for (const row of pass.rows.filter((r) => r.openable === 0)) {
        let probe = null;
        try {
          probe = await invoke("render_probe", { url: row.probe });
        } catch (e) {
          probe = { loaded: false, error: String(e) };
        }
        row.render_probe = probe;
        let why;
        if (!probe.loaded) {
          why = `渲染窗口没能加载这个地址（${probe.error || "无错误信息"}）`;
        } else if (probe.link_count === 0) {
          why = `渲染成功但脚本没有生成任何链接（${probe.html_len} 字符，标题 "${probe.title}"）`;
        } else {
          why = `渲染成功，页面里有 ${probe.link_count} 个链接，但规则仍然匹配不到条目——规则与渲染后的 DOM 对不上`;
        }
        row.still_broken_because = why;
        console.log(`    ${row.name}: ${why}`);
      }
    }
  }

  await writeFile(OUT, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nwritten: ${OUT}`);

  // ---- the number ---------------------------------------------------------
  const offs = results.passes.filter((p) => !p.render_js);
  const ons = results.passes.filter((p) => p.render_js);
  console.log("\n===== summary =====");
  for (const p of results.passes) {
    console.log(`  render_js=${String(p.render_js).padEnd(5)} ${p.working} working / ${p.rule_broken} broken of ${p.rows.length}`);

    // No-verdict guard. `verify::verify_many` fixes its denominator up front
    // (`outcome.total = targets.len()`), so a target that is taken off the
    // queue but never reports is counted and never bucketed — the rate below
    // would then divide by a source nobody classified. Print both numbers and
    // shout when they disagree, rather than letting a tidy-looking summary
    // carry a hole in its denominator.
    const bucketed = p.working + p.rule_broken;
    const verdicts = p.rows.filter((r) => r.verify_bucket && r.verify_bucket !== "error").length;
    if (bucketed !== p.rows.length || verdicts !== p.rows.length) {
      console.log(
        `\n  !!!! NO-VERDICT WARNING (render_js=${p.render_js}): ${bucketed} bucketed / ` +
          `${verdicts} classified of ${p.rows.length} measured. ` +
          `${p.rows.length - bucketed} unclassified and ${p.rows.length - verdicts} without a verdict — ` +
          `every rate for this pass is provisional until that is explained.`,
      );
    } else {
      console.log(`  (${p.rows.length} measured, ${bucketed} bucketed, ${verdicts} classified — every source has a verdict)`);
    }
  }
  if (offs.length && ons.length) {
    const offNames = offs.map((p) => p.rows.filter((r) => r.openable > 0).map((r) => r.name));
    const onNames = ons.map((p) => p.rows.filter((r) => r.openable > 0).map((r) => r.name));
    const gained = ons[ons.length - 1].rows.filter((r) => r.openable > 0 && !offNames[0].includes(r.name)).map((r) => r.name);
    console.log(`  gained by rendering: ${gained.length ? gained.join(", ") : "none"}`);
    console.log(`  lost by rendering:   ${ons[ons.length - 1].rows.filter((r) => r.openable === 0 && offNames[0].includes(r.name)).map((r) => r.name).join(", ") || "none"}`);
    if (offs.length === 2) {
      const drift = offNames[0].filter((n) => !offNames[1].includes(n));
      console.log(`  off/off drift:       ${drift.length ? drift.join(", ") : "none (the batch is stable without rendering)"}`);
    }
    const verifyOn = ons[0].rows.filter((r) => r.verify_bucket === "working").length;
    const verifyOff = offs[0].rows.filter((r) => r.verify_bucket === "working").length;
    console.log(`  verify/audit path: ${verifyOff} working with render off, ${verifyOn} with render on`);
  }
} catch (error) {
  failed = true;
  console.error("render A/B failed:", error.message);
  console.error(diagnostics.slice(-3000));
} finally {
  // Whatever the passes produced is evidence too: write it before tearing the
  // app down, so a crash in the last pass cannot erase the earlier ones.
  if (results?.passes?.length) {
    await writeFile(OUT, JSON.stringify(results, null, 2), "utf8").catch(() => {});
    console.log(`\nwritten: ${OUT}`);
  }
  await browser?.close().catch(() => {});
  child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);