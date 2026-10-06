// Drives the real error notices in a real browser.
//
//   node scripts/reader-error-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-error-preview.html).
//
// What it proves, per scenario, with an observable value rather than "a button
// exists":
//   1. 阅读历史 fails  -> a retry appears, pressing it issues a second
//      list_history call, and the rows come back.
//   2. 阅读统计 fails  -> same, against reading_stats.
//   3. 书架 fails      -> same, against shelf_progress.
//   4. 文章加载失败     -> the notice has a close button at all (it used to have
//      none, so it could not be dismissed), and 重新加载 issues another
//      load_article and clears the error when it succeeds.
//
// The count is read from window.__errProbe.calls, which the harness increments
// per IPC call: a retry that only cleared the error would leave the count flat.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base =
  process.env.READER_ERROR_PREVIEW_URL || "http://localhost:1420/reader-error-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_ERROR_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
let failed = false;

const calls = () => page.evaluate(() => window.__errProbe.calls);

/** Open the preview with one command failing, and wait for its notice. */
async function openFailing(which, cmd, extra = "", view = which) {
  await page.goto(`${base}?view=${view}&fail=${which}&${extra}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector(`[data-retry="${which}"]`, { timeout: 15000 });
  const before = await calls();
  assert.ok(before[cmd] >= 1, `${cmd} was never called (${JSON.stringify(before)})`);
  return before;
}

try {
  // -- 1. 阅读历史 ------------------------------------------------------------
  let before = await openFailing("history", "list_history");
  const notice = (await page.locator(".banner").innerText()).replace(/\s+/g, " ").trim();
  assert.match(notice, /503/, `the reason is not shown: ${notice}`);
  console.log(`  历史 notice: ${notice}`);
  await page.click('[data-retry="history"]');
  await page.waitForFunction(
    (n) => (window.__errProbe.calls.list_history ?? 0) > n,
    before.list_history,
    { timeout: 10000 },
  );
  // Wait for the *finished* state, not the request having started: while the
  // request is in flight the notice is legitimately gone and the spinner is up.
  await page.waitForSelector(".list .row", { timeout: 10000 });
  let after = await calls();
  assert.equal(after.list_history, before.list_history + 1, "the retry did not re-issue list_history");
  console.log(`  历史 retry: list_history ${before.list_history} -> ${after.list_history}, rows back`);

  // -- 2. 阅读统计 ------------------------------------------------------------
  before = await openFailing("stats", "reading_stats");
  await page.click('[data-retry="stats"]');
  await page.waitForFunction(
    (n) => (window.__errProbe.calls.reading_stats ?? 0) > n,
    before.reading_stats,
    { timeout: 10000 },
  );
  await page.waitForSelector(".stats-card", { timeout: 10000 });
  after = await calls();
  assert.equal(after.reading_stats, before.reading_stats + 1, "the retry did not re-issue reading_stats");
  const today = await page.locator('.stats-card[data-period="today"]').getAttribute("data-articles");
  assert.equal(today, "2", `the recovered statistics are wrong: ${today}`);
  console.log(`  统计 retry: reading_stats ${before.reading_stats} -> ${after.reading_stats}, 今日 ${today} 篇`);

  // -- 3. 书架 ----------------------------------------------------------------
  before = await openFailing("shelf", "shelf_progress");
  await page.click('[data-retry="shelf"]');
  await page.waitForFunction(
    (n) => (window.__errProbe.calls.shelf_progress ?? 0) > n,
    before.shelf_progress,
    { timeout: 10000 },
  );
  await page.waitForSelector(".list .row", { timeout: 10000 });
  after = await calls();
  assert.equal(after.shelf_progress, before.shelf_progress + 1, "the retry did not re-issue shelf_progress");
  const shelfRow = (await page.locator(".list .row-title").first().innerText()).trim();
  console.log(`  书架 retry: shelf_progress ${before.shelf_progress} -> ${after.shelf_progress}, row "${shelfRow}"`);

  // -- 4. 文章加载失败：先证明现在关得掉 ---------------------------------------
  // Before this round the reader's notice was rendered without `onClose`, so the
  // ✕ never rendered and the red bar stayed until another article was opened.
  before = await openFailing("article", "load_article", "", "reader");
  const articleNotice = page.locator(".banner").first();
  await articleNotice.waitFor({ timeout: 10000 });
  const closeCount = await articleNotice.locator('button[aria-label="关闭"]').count();
  assert.equal(closeCount, 1, "the article error notice still has no close button");
  const articleText = (await articleNotice.innerText()).replace(/\s+/g, " ").trim();
  console.log(`  文章 notice (closable): ${articleText}`);

  // 重新加载 really re-issues the request, and the notice goes away on success.
  await page.click('[data-retry="article"]');
  await page.waitForFunction(
    (n) => (window.__errProbe.calls.load_article ?? 0) > n,
    before.load_article,
    { timeout: 10000 },
  );
  await page.waitForFunction(() => document.querySelectorAll(".banner").length === 0, null, {
    timeout: 10000,
  });
  after = await calls();
  assert.equal(after.load_article, before.load_article + 1, "重新加载 did not re-issue load_article");
  console.log(`  文章 retry: load_article ${before.load_article} -> ${after.load_article}, notice cleared`);

  // And the close button works when the failure is still standing.
  await page.goto(`${base}?view=reader&fail=article&failTimes=99`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".banner", { timeout: 15000 });
  await page.locator('.banner button[aria-label="关闭"]').first().click();
  await page.waitForFunction(() => document.querySelectorAll(".banner").length === 0, null, {
    timeout: 5000,
  });
  console.log("  ✕ closes the article error (this was impossible before this round)");

  await page.goto(`${base}?view=history&fail=history`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-retry="history"]', { timeout: 15000 });
  await page.screenshot({ path: path.join(outDir, "reader-error.png") });
  console.log("  screenshot: test-results/reader-error.png");

  // A notice that is not closable is not offered a close button; one that is a
  // plain success note must not grow a fake retry.
  const closable = await page.evaluate(() => {
    const b = document.querySelector(".banner");
    return {
      close: b?.querySelector('button[aria-label="关闭"]') !== null,
      retry: b?.querySelector("[data-retry]") !== null,
    };
  });
  assert.deepEqual(closable, { close: true, retry: true }, `banner shape is wrong: ${JSON.stringify(closable)}`);
  console.log(`  a failing notice carries both a close and a retry: ${JSON.stringify(closable)}`);
} catch (error) {
  failed = true;
  console.error("reader error test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-error-failure.png") });
    console.error("  failure screenshot: test-results/reader-error-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
