// Drives the real ArticleList star and the real ShelfPanel.
//
//   node scripts/shelf-test.mjs
//
// Needs `pnpm dev` running.
//
// What it proves:
//   - the star saves the category on screen, and only that category
//   - the star's own label reflects the saved state without a reload
//   - saving twice does not create two rows
//   - the shelf survives a reload, because it is persisted rather than local
//   - removing a row takes it off and leaves the rest alone
//   - opening a row hands back the entry, not just the url
//
// Uses shelf-preview.html, which mounts the production components against a
// stubbed backend.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.SHELF_PREVIEW_URL || "http://localhost:1420/shelf-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.SHELF_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 860 } });
let failed = false;

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  // Start from a known shelf rather than whatever the last run left behind.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shelf-bar button", { timeout: 15000 });
  await page.waitForSelector(".grid .card", { timeout: 15000 });

  const star = page.locator(".shelf-bar button");
  const hint = page.locator(".shelf-bar-hint");
  assert.match((await star.innerText()).trim(), /收进书架/, "the star should start unsaved");
  assert.match(await hint.innerText(), /全部/, "the star should name the category on screen");
  console.log(`  star starts as "${(await star.innerText()).trim()}" · ${(await hint.innerText()).trim()}`);

  // -- saving ---------------------------------------------------------------
  await star.click();
  await page.waitForFunction(
    () => document.querySelector(".shelf-bar button")?.textContent?.includes("已在书架"),
    null,
    { timeout: 5000 },
  );
  assert.match(await star.innerText(), /★/, "the saved star should be filled");
  console.log(`  after saving: ${(await star.innerText()).trim()}`);

  // The count in the header tab must follow, without a reload.
  const tab = (await page.locator(".main-head button").last().innerText()).trim();
  assert.ok(/\b1\b/.test(tab), `the shelf count did not update (${tab})`);
  console.log(`  header tab reads: ${tab}`);

  // -- only the visible category is saved ------------------------------------
  await page.locator(".cat", { hasText: "玄幻" }).click();
  await page.waitForFunction(
    () => !document.querySelector(".shelf-bar button")?.textContent?.includes("已在书架"),
    null,
    { timeout: 5000 },
  );
  assert.match(await hint.innerText(), /玄幻/, "the star did not follow the category");
  assert.match(await star.innerText(), /收进书架/, "the other category looks saved too");
  console.log("  switching category clears the saved state");

  await star.click();
  await page.waitForFunction(
    () => document.querySelector(".shelf-bar button")?.textContent?.includes("已在书架"),
    null,
    { timeout: 5000 },
  );

  // -- saving twice is still two rows, not four ------------------------------
  await star.click(); // off
  await page.waitForFunction(
    () => !document.querySelector(".shelf-bar button")?.textContent?.includes("已在书架"),
    null,
    { timeout: 5000 },
  );
  await star.click(); // on again
  await page.waitForFunction(
    () => document.querySelector(".shelf-bar button")?.textContent?.includes("已在书架"),
    null,
    { timeout: 5000 },
  );
  const tabAfter = (await page.locator(".main-head button").last().innerText()).trim();
  assert.ok(/\b2\b/.test(tabAfter), `re-saving duplicated a row (${tabAfter})`);
  console.log(`  re-saving kept the count at ${tabAfter}`);

  // -- it is persisted, not local state --------------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shelf-bar button", { timeout: 15000 });
  const tabReload = (await page.locator(".main-head button").last().innerText()).trim();
  assert.ok(/\b2\b/.test(tabReload), `the shelf did not survive a reload (${tabReload})`);
  console.log(`  after a reload the shelf still holds ${tabReload}`);

  // -- the panel -------------------------------------------------------------
  await page.locator(".main-head button").last().click();
  await page.waitForSelector(".list .row", { timeout: 10000 });
  const rows = await page.locator(".list .row").count();
  assert.equal(rows, 2, `the panel lists ${rows} rows, expected 2`);
  const titles = await page.locator(".list .row-title").allInnerTexts();
  assert.ok(titles.some((t) => t.includes("全部")), `missing the saved 全部 entry: ${titles}`);
  assert.ok(titles.some((t) => t.includes("玄幻")), `missing the saved 玄幻 entry: ${titles}`);
  console.log(`  panel lists: ${titles.map((t) => t.trim()).join(" | ")}`);
  await page.screenshot({ path: path.join(outDir, "shelf.png") });
  console.log("  screenshot: test-results/shelf.png");

  // -- book progress, not just the first item --------------------------------
// A bookshelf that only says "you read chapter 1" does not answer the question
// a reader asks: how much of the book is left?
await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("serious-dev-store") ?? "{}");
    // The 全部 list holds two chapters: one finished, one part-read.
    store.progress = { "https://demo.local/1": 1, "https://demo.local/2": 0.4 };
    localStorage.setItem("serious-dev-store", JSON.stringify(store));
  });
  // The panel is already open; go back and reopen so it re-reads the store.
  await page.locator(".main-head button", { hasText: "返回" }).click();
  await page.getByRole("button", { name: /书架/ }).first().click();
  await page.waitForSelector(".list .row", { timeout: 10000 });
  const allRow = page.locator(".list .row", { hasText: "全部" }).first();
  await allRow.waitFor({ timeout: 5000 });
  const read = (await allRow.locator(".shelf-read").innerText()).trim();
  assert.ok(read.includes("已读 1 / 2 章"), `book progress wrong: ${read}`);
  assert.ok(read.includes("另有 1 章读到一半"), `part-read chapter not counted: ${read}`);
  assert.ok(read.includes("50%"), `percentage wrong: ${read}`);
  const width = await allRow.locator(".row-progress > div").evaluate((el) => el.style.width);
  assert.equal(width, "50%", `the bar does not match the numbers (${width})`);
  console.log(`  book progress: ${read}`);

  // The 玄幻 list has one chapter, unread: zero, and no bar to mislead.
  const other = (await page.locator(".list .row", { hasText: "玄幻" }).first().locator(".shelf-read").innerText()).trim();
  assert.ok(other.includes("已读 0 / 1 章"), `an unread list reported progress: ${other}`);
  console.log(`  an unread list says: ${other}`);

  await page.screenshot({ path: path.join(outDir, "shelf-progress.png") });
  console.log("  screenshot: test-results/shelf-progress.png");

  // -- opening a row ---------------------------------------------------------
  await page.locator(".list .row", { hasText: "玄幻" }).first().click();
  await page.waitForSelector(".banner", { timeout: 5000 });
  const opened = (await page.locator(".banner").innerText()).trim();
  assert.ok(opened.includes("玄幻"), `opening the row handed back "${opened}"`);
  console.log(`  opening a row returns the entry: ${opened}`);

  // -- removing --------------------------------------------------------------
  // Opening a row returned to the list, so the shelf button is there again.
  await page.getByRole("button", { name: /书架/ }).first().click();
  await page.waitForSelector(".list .row", { timeout: 10000 });
  const before = (await page.locator(".list .row-title").allInnerTexts()).map((t) => t.trim());
  assert.equal(before.length, 2, `expected two rows to remove from, got ${before.length}`);

  // Remove whichever row is first, and check that exactly that one went — not
  // that "the other one is left", which passes just as well if the wrong button
  // was pressed.
  const doomed = before[0];
  await page.locator('.list .row button[aria-label^="从书架移除"]').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll(".list .row").length === 1,
    null,
    { timeout: 5000 },
  );
  const left = (await page.locator(".list .row-title").allInnerTexts()).map((t) => t.trim());
  assert.equal(left.length, 1, `removing left ${left.length} rows`);
  assert.ok(!left[0].includes(doomed.split("·").pop().trim()), `the wrong row was removed (${left[0]})`);
  console.log(`  removed "${doomed}"; "${left[0]}" is still there`);
} catch (error) {
  failed = true;
  console.error("shelf test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "shelf-failure.png") });
    console.error("  failure screenshot: test-results/shelf-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);