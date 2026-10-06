// History beyond the old 300 cap: loadable and searchable.
//
//   node scripts/history-more-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-nav-preview.html).
//
// The nav preview now seeds 350 history records (2 fresh + 348 old, one of
// them titled 三百条外的远古篇 at sorted position 303). The panel pages 100
// at a time. This script proves:
//   1. the first page shows 100 rows and asks list_history with limit=100
//      (not the old hardcoded 300);
//   2. 「加载更多更早记录」 pages 100 → 200 → 300 → 350;
//   3. the record past position 300 (三百条外的远古篇) is unreachable on the
//      first page and becomes visible only after paging past it;
//   4. typing in the search box narrows the loaded rows to the match.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base = process.env.READER_NAV_PREVIEW_URL || "http://localhost:1420/reader-nav-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.HISTORY_MORE_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
let failed = false;

const rows = () => page.locator(".list .row").count();
const limits = () => page.evaluate(() => window.__historyLimits ?? []);
const countText = () =>
  page.locator('[data-history-count]').innerText().then((t) => t.replace(/\s+/g, " ").trim()).catch(() => null);

try {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.getByRole("button", { name: "历史" }).click();
  await page.waitForSelector(".list .row", { timeout: 10000 });

  // -- 1. first page ----------------------------------------------------------
  const firstRows = await rows();
  // StrictMode mounts effects twice in dev: two list_history(100) calls are
  // the framework's doing, not a double fetch bug. What matters is the
  // limit asked, not the call count.
  const firstLimits = await limits();
  console.log(`  first page: rows=${firstRows}, list_history limits=${JSON.stringify(firstLimits)}`);
  assert.equal(firstRows, 100, `expected 100 rows on the first page, got ${firstRows}`);
  assert.ok(
    firstLimits.length >= 1 && firstLimits.every((n) => n === 100),
    `expected list_history(100)s, got ${JSON.stringify(firstLimits)}`,
  );
  const callsBeforeMore = firstLimits.length;

  // The far record is beyond the first page: searching now must NOT find it
  // (search only narrows what is loaded — it must not pretend to be global).
  await page.fill('[data-history-field="search"]', "远古篇");
  await page.waitForTimeout(300);
  const earlySearch = await rows();
  const earlyText = await countText();
  console.log(`  search before paging: rows=${earlySearch} "${earlyText}"`);
  assert.equal(earlySearch, 0, "the far record was found before its page was loaded");
  await page.fill('[data-history-field="search"]', "");
  await page.waitForTimeout(300);

  // -- 2. page to 200, then past 300 ------------------------------------------
  await page.click('[data-history-action="more"]');
  await page.waitForFunction(() => document.querySelectorAll(".list .row").length === 200, null, { timeout: 8000 });
  const afterFirst = await limits();
  assert.equal(
    afterFirst[afterFirst.length - 1],
    200,
    `paging must ask limit=200: ${JSON.stringify(afterFirst)}`,
  );
  console.log(`  after 1st more: rows=${await rows()}, limits=${JSON.stringify(afterFirst)}`);

  await page.click('[data-history-action="more"]');
  await page.waitForFunction(() => document.querySelectorAll(".list .row").length >= 300, null, { timeout: 8000 });
  const thirdRows = await rows();
  const thirdLimits = await limits();
  console.log(`  after 2nd more: rows=${thirdRows}, limits=${JSON.stringify(thirdLimits)}`);
  assert.ok(thirdRows >= 300, `expected 300+ rows, got ${thirdRows}`);
  assert.equal(
    thirdLimits[thirdLimits.length - 1],
    300,
    `paging must grow the limit to 300: ${JSON.stringify(thirdLimits)}`,
  );

  // The far record sits at sorted position 303 — one more page reaches it.
  await page.click('[data-history-action="more"]');
  await page.waitForFunction(() => document.querySelectorAll(".list .row").length >= 350, null, { timeout: 8000 });
  console.log(`  after 3rd more: rows=${await rows()}, limits=${JSON.stringify(await limits())}`);

  // -- 3. the far record is now reachable --------------------------------------
  const farVisible = await page.locator(".list .row", { hasText: "三百条外的远古篇" }).count();
  assert.equal(farVisible, 1, "the record past position 300 is not reachable after paging");
  console.log("  far record visible after paging: 三百条外的远古篇");

  // -- 4. search narrows loaded rows --------------------------------------------
  await page.fill('[data-history-field="search"]', "远古篇");
  await page.waitForTimeout(300);
  const found = await rows();
  const foundText = await countText();
  console.log(`  search after paging: rows=${found} "${foundText}"`);
  assert.equal(found, 1, `search should narrow to the one match, got ${found}`);
  assert.match(foundText ?? "", /搜到 1 条/, `no search count: ${foundText}`);

  await page.screenshot({ path: path.join(outDir, "history-more.png") });
  console.log("  screenshot: test-results/history-more.png");
} catch (error) {
  failed = true;
  console.error("history more test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "history-more-failure.png") });
    console.error("  failure screenshot: test-results/history-more-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
