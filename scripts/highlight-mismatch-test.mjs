// A highlight the page no longer contains must say so — not vanish silently.
//
//   node scripts/highlight-mismatch-test.mjs
//
// Needs `pnpm dev` running (it serves /highlight-preview.html).
//
// Fixture: two stored highlights for the same article. One matches the page
// ("让人愿意一直读下去", split across a <strong> — the case paint already
// handles); the other ("这段话在改写后的源文里根本不存在") matches nothing,
// which is what a source rewrite looks like: paintHighlight returns 0.
//
// What it proves, against the real Reader (never recreated markup):
//   LEG A (rewrite): exactly one <mark> is painted (the match is not faked),
//     and a [data-paint-mismatch] notice names the missed quote plus a
//     查看原文 entry that reveals the full text.
//   LEG B (pure-text): switching to 纯文本 lists both highlights as
//     unpositioned (there is no rich DOM to paint into), again with a notice
//     and a view-original entry — not a blank page pretending all is well.
//
// Pre-fix this script fails: the missed highlight paints 0 <mark>s and the
// page shows no notice at all (that silence is the bug).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.HIGHLIGHT_MISMATCH_URL || "http://localhost:1420/highlight-preview.html";

const URL_UNDER_TEST = "https://demo.local/article/1";
const MATCH_TEXT = "让人愿意一直读下去";
const MISS_TEXT = "这段话在改写后的源文里根本不存在对不上任何位置";

const SEED = [
  {
    id: "hm-match",
    url: URL_UNDER_TEST,
    source_id: "demo:novel",
    title: "关于阅读器",
    source_name: "演示源",
    text: MATCH_TEXT,
    note: "",
    created_at: 1_700_000_000,
  },
  {
    id: "hm-miss",
    url: URL_UNDER_TEST,
    source_id: "demo:novel",
    title: "关于阅读器",
    source_name: "演示源",
    text: MISS_TEXT,
    note: "",
    created_at: 1_700_000_100,
  },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.HIGHLIGHT_MISMATCH_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

// Seed *before the app starts*: writing while the Reader is mounted is how a
// test quietly changes what it measures (see marks-panel-test.mjs).
await page.addInitScript((items) => {
  if (localStorage.getItem("mismatch-test-seeded")) return;
  try {
    const store = JSON.parse(localStorage.getItem("serious-dev-store") ?? "{}");
    localStorage.setItem("serious-dev-store", JSON.stringify({ ...store, highlights: items }));
  } catch {
    /* harness problem, not this test's */
  }
  localStorage.setItem("mismatch-test-seeded", "1");
}, SEED);

const marks = () => page.locator(".reader-rich mark.reader-mark").count();
const mismatchBox = () => page.locator("[data-paint-mismatch]").count();

try {
  console.log(`  url: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".reader-rich", { timeout: 15000 });
  // Let the repaint effect (clear + paint + notice state) settle, twice over
  // for StrictMode's double-invoke.
  await page.waitForTimeout(1200);

  // -- LEG A: one paints, one misses, the miss must be named -----------------
  const painted = await marks();
  console.log(`  painted marks in page: ${painted} (seeded 2: 1 match + 1 rewrite-miss)`);
  assert.equal(painted, 1, `expected exactly the matching passage painted, saw ${painted} <mark>s`);

  const boxes = await mismatchBox();
  assert.ok(
    boxes > 0,
    "LEG A FAILED: 1 highlight painted 0 marks (source rewrite) but the page shows no mismatch notice — the miss is silent",
  );
  const boxText = ((await page.locator("[data-paint-mismatch]").first().innerText()).replace(/\s+/g, " ").trim());
  console.log(`  mismatch notice reads: "${boxText.slice(0, 90)}"`);
  assert.ok(/1\s*条划线/.test(boxText), `the notice does not own the count: "${boxText.slice(0, 80)}"`);
  assert.ok(
    boxText.includes(MISS_TEXT.slice(0, 10)),
    `the notice does not name the missed quote: "${boxText.slice(0, 80)}"`,
  );
  // The matched passage must not be listed as missed (no pretending).
  assert.ok(
    !boxText.includes(MATCH_TEXT),
    `the notice blames the passage that IS on the page: "${boxText.slice(0, 80)}"`,
  );
  console.log("  PASS LEG A: rewrite-miss is named, the match is not blamed");

  // 查看原文 entry reveals the full missed text.
  await page.locator("[data-mismatch-view]").first().click();
  await page.waitForSelector("[data-mismatch-full]", { timeout: 4000 });
  const full = (await page.locator("[data-mismatch-full]").first().innerText()).replace(/\s+/g, "");
  assert.ok(
    full.includes(MISS_TEXT.replace(/\s+/g, "")),
    `view-original does not reveal the full quote (saw "${full.slice(0, 40)}")`,
  );
  console.log(`  view-original reveals: "${full.slice(0, 30)}…"`);
  await page.screenshot({ path: path.join(outDir, "highlight-mismatch.png") });
  console.log("  screenshot: test-results/highlight-mismatch.png");

  // -- LEG B: pure-text mode cannot paint, and must say so --------------------
  await page.getByRole("button", { name: "纯文本", exact: true }).click();
  await page.waitForTimeout(1000);
  const textBoxes = await mismatchBox();
  assert.ok(textBoxes > 0, "LEG B FAILED: pure-text mode shows no notice — 2 highlights are unpositioned but silent");
  const textNotice = ((await page.locator("[data-paint-mismatch]").first().innerText()).replace(/\s+/g, " ").trim());
  console.log(`  pure-text notice reads: "${textNotice.slice(0, 90)}"`);
  assert.ok(/2\s*条划线/.test(textNotice), `pure-text notice does not own both: "${textNotice.slice(0, 80)}"`);
  assert.ok(/纯文本/.test(textNotice), `pure-text notice does not name the mode: "${textNotice.slice(0, 80)}"`);
  console.log("  PASS LEG B: pure-text lists both as unpositioned");

  // Back to 原页: the rewrite-miss returns alone (mode switch did not lose it).
  await page.getByRole("button", { name: "原页", exact: true }).click();
  await page.waitForTimeout(1000);
  const backNotice = ((await page.locator("[data-paint-mismatch]").first().innerText()).replace(/\s+/g, " ").trim());
  assert.ok(/1\s*条划线/.test(backNotice), `returning to rich lost the miss: "${backNotice.slice(0, 80)}"`);
  console.log("  back on 原页: rewrite-miss alone again");
} catch (error) {
  failed = true;
  console.error("highlight mismatch test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "highlight-mismatch-failure.png") });
    console.error("  failure screenshot: test-results/highlight-mismatch-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
