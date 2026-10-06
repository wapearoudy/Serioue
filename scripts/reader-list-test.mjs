// Drives the real ArticleList in a real browser and measures the four fixes
// this round is about.
//
//   node scripts/reader-list-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-list-preview.html).
//
// What it measures, before and after:
//   1. 清除搜索 — the list actually goes back to the category contents, not just
//      an empty search box. Asserted on the items on screen.
//   2. 重试 — a failed request produces a retry button, and pressing it really
//      issues the request again (the harness counts the calls).
//   3. 键盘可达 — Tab reaches a card, document.activeElement is that card, and
//      Enter opens the article. Real key presses, not synthetic clicks.
//   4. 切分类不闪烁 — the card count never drops to zero while switching.
//
// It also checks the search context bar, which is what tells the reader that
// the list on screen is not the category.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base = process.env.READER_LIST_PREVIEW_URL || "http://localhost:1420/reader-list-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_LIST_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
let failed = false;

/** Titles of the cards on screen, in order. */
const titles = () => page.locator(".card-title").allInnerTexts();
const cardCount = () => page.locator(".card").count();
const probe = () => page.evaluate(() => window.__listProbe);

async function open(query = "") {
  await page.goto(`${base}${query}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".card, .empty", { timeout: 15000 });
}

try {
  // -- 1. clearing a search returns to the category list ---------------------
  await open();
  const browsing = await titles();
  assert.equal(browsing.length, 3, `the category listing should have 3 items: ${JSON.stringify(browsing)}`);
  console.log(`  browsing 「全部」: ${browsing.map((t) => t.trim()).join(" | ")}`);

  await page.fill('input[aria-label^="在"]', "山海经");
  await page.press('input[aria-label^="在"]', "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1, null, { timeout: 5000 });
  const searched = await titles();
  assert.match(searched[0], /搜索命中/, `the search did not replace the list: ${JSON.stringify(searched)}`);
  console.log(`  after searching 「山海经」: ${searched.map((t) => t.trim()).join(" | ")}`);

  // The context bar is the other half of the fix: the reader has to be told.
  const context = await page.locator("[data-list-context]").innerText();
  assert.match(context, /山海经/, `the context bar does not name the search: ${context}`);
  assert.match(context, /1 条/, `the context bar does not count the results: ${context}`);
  console.log(`  context bar: ${context.replace(/\s+/g, " ").trim()}`);

  // The actual bug: before the fix this only emptied the box and left the
  // search results on screen.
  await page.getByRole("button", { name: "清除" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 5000 });
  const cleared = await titles();
  assert.deepEqual(
    cleared.map((t) => t.trim()),
    browsing.map((t) => t.trim()),
    `清除 did not bring the category listing back: ${JSON.stringify(cleared)}`,
  );
  assert.equal(await page.inputValue('input[aria-label^="在"]'), "", "the search box was not cleared");
  assert.equal(await page.locator("[data-list-context]").count(), 0, "the context bar outlived the search");
  console.log(`  after 清除: ${cleared.map((t) => t.trim()).join(" | ")}`);

  // The 「回到分类列表」 button is the same promise, offered where the eye is.
  await page.fill('input[aria-label^="在"]', "山海经");
  await page.press('input[aria-label^="在"]', "Enter");
  await page.waitForSelector("[data-list-action='back-to-list']", { timeout: 5000 });
  await page.locator("[data-list-action='back-to-list']").click();
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 5000 });
  console.log(`  回到分类列表: ${(await cardCount())} cards, context bar gone`);

  // -- 3. keyboard reaches a card and opens it -------------------------------
  await page.locator('input[aria-label^="在"]').focus();
  let landed = false;
  for (let i = 0; i < 12 && !landed; i++) {
    await page.keyboard.press("Tab");
    landed = await page.evaluate(() => document.activeElement?.getAttribute("data-card") === "1");
  }
  assert.ok(landed, "Tab never reached a card");
  const focusedLabel = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    role: document.activeElement?.getAttribute("role"),
    tabIndex: document.activeElement?.getAttribute("tabindex"),
    label: document.activeElement?.getAttribute("aria-label"),
    // The focus ring has to be visible, not merely present.
    outline: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : "",
  }));
  assert.equal(focusedLabel.tag, "DIV");
  assert.equal(focusedLabel.role, "button");
  assert.equal(focusedLabel.tabIndex, "0");
  assert.match(focusedLabel.label ?? "", /第一章/, `the card has no readable label: ${focusedLabel.label}`);
  assert.notEqual(focusedLabel.outline, "none", "the focused card has no visible focus ring");
  console.log(`  Tab lands on a card: role=${focusedLabel.role} outline=${focusedLabel.outline}`);
  console.log(`  announced as: "${focusedLabel.label}"`);

  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-opened]", { timeout: 5000 });
  const opened = (await page.locator("[data-opened]").innerText()).trim();
  assert.match(opened, /第一章/, `Enter did not open the focused card: ${opened}`);
  console.log(`  Enter opened: ${opened}`);

  // Space does the same, and must not scroll the list away.
  await page.locator(".card").first().focus();
  const beforeScroll = await page.evaluate(() => document.querySelector(".main-body")?.scrollTop ?? -1);
  await page.keyboard.press("Space");
  await page.waitForSelector("[data-opened]", { timeout: 5000 });
  const afterScroll = await page.evaluate(() => document.querySelector(".main-body")?.scrollTop ?? -1);
  assert.equal(afterScroll, beforeScroll, "Space opened the card but also scrolled the list");
  console.log("  Space opens too, without scrolling the page");

  await page.screenshot({ path: path.join(outDir, "reader-list.png") });
  console.log("  screenshot: test-results/reader-list.png");

  // -- 4. switching category does not empty the list -------------------------
  await open("?slow=500");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 8000 });
  // Watch the card count while the next category is on its way.
  await page.evaluate(() => {
    window.__minCards = Infinity;
    const timer = setInterval(() => {
      const n = document.querySelectorAll(".card").length;
      if (n < window.__minCards) window.__minCards = n;
    }, 25);
    window.__stopWatch = setTimeout(() => clearInterval(timer), 2500);
  });
  await page.locator(".cat", { hasText: "玄幻" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 4, null, { timeout: 10000 });
  const flicker = await page.evaluate(() => {
    clearTimeout(window.__stopWatch);
    return window.__minCards;
  });
  assert.equal(
    flicker,
    3,
    `the list emptied while switching (dropped to ${flicker} cards); it should have kept the old one`,
  );
  const staleSeen = await page.evaluate(() => document.querySelector(".grid")?.getAttribute("data-list-state"));
  console.log(`  switching category never dropped below ${flicker} cards (last state: ${staleSeen})`);

  // -- 2. a failure offers a retry that really retries ------------------------
  // `fail=2` fails the first two requests: StrictMode mounts effects twice in
  // development, and the budget has to survive that for this to be a test of the
  // retry rather than of the double mount.
  await open("?fail=2");
  await page.waitForSelector(".empty", { timeout: 10000 });
  const failedText = (await page.locator(".empty").innerText()).replace(/\s+/g, " ").trim();
  assert.match(failedText, /没能加载这个分类/, `the failure state is unhelpful: ${failedText}`);
  assert.match(failedText, /502/, `the reason was not shown: ${failedText}`);
  assert.equal(await page.locator("[data-list-action='retry']").count(), 1, "no retry button on failure");
  const before = await probe();
  console.log(`  failure state: ${failedText.slice(0, 60)}…`);

  await page.locator("[data-list-action='retry']").click();
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 10000 });
  const after = await probe();
  assert.equal(after.requests, before.requests + 1, `retry did not re-issue the request (${JSON.stringify(after)})`);
  console.log(`  retry re-issued the request: ${before.requests} -> ${after.requests} calls, list recovered`);

  // A retry that fails again must keep offering the button, not go quiet.
  await open("?fail=all");
  await page.waitForSelector(".empty", { timeout: 10000 });
  const firstCount = (await probe()).requests;
  await page.locator("[data-list-action='retry']").click();
  // Wait for the request to *finish*, not to start. `retry()` clears the error
  // first, so while the request is in flight the notice is legitimately gone and
  // the list legitimately shows a spinner — waiting on "the count went up" reads
  // that in-between moment, where the button is correctly absent.
  await page.locator("[data-list-action='retry']").waitFor({ timeout: 10000 });
  const afterRetry = await probe();
  assert.ok(
    afterRetry.requests > firstCount,
    `the retry did not re-issue the request (${JSON.stringify(afterRetry)})`,
  );
  assert.equal(
    await page.locator("[data-list-action='retry']").count(),
    1,
    "a failed retry left no way to try again",
  );
  console.log(`  a failed retry still offers the button (${firstCount} -> ${afterRetry.requests} calls)`);

  // -- a failing search is reported the same way -----------------------------
  await open("?searchFails=1");
  await page.fill('input[aria-label^="在"]', "山海经");
  await page.press('input[aria-label^="在"]', "Enter");
  await page.waitForSelector(".empty", { timeout: 10000 });
  const searchFailed = (await page.locator(".empty").innerText()).replace(/\s+/g, " ").trim();
  assert.match(searchFailed, /搜索没有成功/, `the search failure is unhelpful: ${searchFailed}`);
  assert.equal(
    await page.locator("[data-list-context]").count(),
    0,
    "a failed search claimed results were on screen",
  );
  console.log(`  search failure: ${searchFailed.slice(0, 48)}…`);

  // -- an empty search result offers the way back ----------------------------
  await open();
  await page.fill('input[aria-label^="在"]', "不存在的关键词");
  await page.press('input[aria-label^="在"]', "Enter");
  await page.waitForSelector("[data-list-context]", { timeout: 5000 });
  const noHits = (await page.locator(".empty").innerText()).replace(/\s+/g, " ").trim();
  assert.match(noHits, /没有搜到/, `the no-results state is unhelpful: ${noHits}`);
  assert.equal(
    await page.locator("[data-list-action='back-to-list']").count() > 0,
    true,
    "the no-results state offers no way back to browsing",
  );
  await page.locator(".empty [data-list-action='back-to-list']").click();
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 3, null, { timeout: 5000 });
  console.log(`  no results: ${noHits.split("。")[0]}… and the way back works`);
} catch (error) {
  failed = true;
  console.error("reader list test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-list-failure.png") });
    console.error("  failure screenshot: test-results/reader-list-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
