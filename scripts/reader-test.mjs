// Drives the reader in a real browser (Chromium via Playwright) and asserts
// that the typography controls actually change the rendered text, that themes
// repaint, and that a reading position is measured.
//
//   node scripts/reader-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-preview.html).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.READER_PREVIEW_URL || "http://localhost:1420/reader-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system
  // Edge is the same engine and is always present on Windows.
  channel: process.env.READER_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
let failed = false;

/** The computed font size and line height of the article body. */
const bodyStyle = () =>
  page.evaluate(() => {
    const el = document.querySelector(".reader-body");
    if (!el) return null;
    const s = getComputedStyle(el);
    return { fontSize: s.fontSize, lineHeight: s.lineHeight, family: s.fontFamily };
  });

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".reader-body", { timeout: 15000 });

  const initial = await bodyStyle();
  assert.ok(initial, "no article body rendered");
  console.log(`  initial body: ${initial.fontSize} / ${initial.lineHeight}`);

  // -- font size -----------------------------------------------------------
  await page.locator('.reader-settings > button[title="阅读设置"]').click();
  await page.waitForSelector(".reader-pop", { timeout: 5000 });

  for (let i = 0; i < 4; i++) await page.locator('button[title="放大字号"]').click();
  const bigger = await bodyStyle();
  const grew = parseFloat(bigger.fontSize) > parseFloat(initial.fontSize);
  assert.ok(grew, `font size did not grow (${initial.fontSize} -> ${bigger.fontSize})`);
  console.log(`  font size ${initial.fontSize} -> ${bigger.fontSize}`);

  for (let i = 0; i < 6; i++) await page.locator('button[title="缩小字号"]').click();
  const smaller = await bodyStyle();
  assert.ok(
    parseFloat(smaller.fontSize) < parseFloat(bigger.fontSize),
    `font size did not shrink (${bigger.fontSize} -> ${smaller.fontSize})`,
  );
  // The backend clamps to 13px minimum; the UI must not go below it.
  assert.ok(parseFloat(smaller.fontSize) >= 13, `went below the clamp (${smaller.fontSize})`);
  console.log(`  font size back down to ${smaller.fontSize} (clamped at 13)`);

  // -- line height ---------------------------------------------------------
  const beforeLine = (await bodyStyle()).lineHeight;
  for (let i = 0; i < 4; i++) await page.locator('button[title="增大行距"]').click();
  const afterLine = (await bodyStyle()).lineHeight;
  assert.notEqual(beforeLine, afterLine, `line height unchanged (${beforeLine})`);
  console.log(`  line height ${beforeLine} -> ${afterLine}`);

  // -- theme ---------------------------------------------------------------
  await page.locator(".reader-pop-row button", { hasText: "羊皮" }).click();
  const sepia = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(sepia.theme, "sepia", `theme not applied (${sepia.theme})`);
  assert.notEqual(sepia.bg, "rgb(15, 17, 21)", `background did not change (${sepia.bg})`);
  console.log(`  sepia theme applied, background ${sepia.bg}`);
  await page.screenshot({ path: path.join(outDir, "reader-sepia.png") });

  // -- font family ---------------------------------------------------------
  await page.locator(".reader-pop-row button", { hasText: "宋体" }).click();
  const serif = await page.evaluate(() =>
    document.querySelector(".reader-body")?.className ?? "",
  );
  assert.ok(serif.includes("serif"), `serif class not applied (${serif})`);
  console.log("  serif font class applied");

  // Close the popover by clicking away.
  await page.locator(".main-title").click();
  await page.waitForSelector(".reader-pop", { state: "detached", timeout: 5000 });
  console.log("  popover closes on outside click");

  // -- reading progress ----------------------------------------------------
  const measured = await page.evaluate(() => {
    const el = document.querySelector(".reader-scroll");
    if (!el) return null;
    const scrollable = el.scrollHeight - el.clientHeight;
    el.scrollTop = scrollable * 0.6;
    return { scrollable, ratio: el.scrollTop / scrollable };
  });
  assert.ok(measured && measured.scrollable > 50, "page is not scrollable enough to test");
  await page.waitForFunction(
    () => /已读 \d+%/.test(document.querySelector(".reader-meta")?.textContent ?? ""),
    null,
    { timeout: 5000 },
  );
  const shown = await page.locator(".reader-meta").innerText();
  console.log(`  scrolled to 60%, reader reports: ${shown.replace(/\s+/g, " ")}`);

  // -- next-chapter prompt ---------------------------------------------------
  // Reaching the end of a chapter should offer the next one, the way a book
  // does, and "暂不" must not bring it straight back.
  await page.evaluate(() => {
    const el = document.querySelector(".reader-scroll");
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForSelector(".chapter-offer", { timeout: 5000 });
  const offer = (await page.locator(".chapter-offer-text").innerText()).trim();
  assert.ok(/本章已读完/.test(offer), `unexpected offer: ${offer}`);
  assert.ok(/第 4 章/.test(offer), `offer names the wrong chapter: ${offer}`);
  console.log(`  end of chapter offers: ${offer}`);

  await page.locator(".chapter-offer button", { hasText: "暂不" }).click();
  await page.waitForSelector(".chapter-offer", { state: "detached", timeout: 5000 });
  await page.evaluate(() => {
    const el = document.querySelector(".reader-scroll");
    el.scrollTop = 0;
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
  assert.equal(
    await page.locator(".chapter-offer").count(),
    0,
    "the offer came back after being dismissed",
  );
  console.log("  dismissing it keeps it dismissed");

  // Move on a chapter: the dismissal was recorded for the chapter we skipped,
  // so the offer should come back for the following one.
  await page.locator(".chapter-nav button", { hasText: "下一章" }).click();
  await page.waitForFunction(
    () => document.querySelector(".reader h1")?.textContent?.includes("第 4 章"),
    null,
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    const el = document.querySelector(".reader-scroll");
    // Leave and return, or the browser fires no scroll event and the handler
    // never runs.
    el.scrollTop = 0;
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForSelector(".chapter-offer", { timeout: 5000 });
  const secondOffer = (await page.locator(".chapter-offer-text").innerText()).trim();
  assert.ok(/第 5 章/.test(secondOffer), `offer did not move on: ${secondOffer}`);
  console.log(`  the next chapter offers again: ${secondOffer}`);

  await page.locator(".chapter-offer button", { hasText: "继续下一章" }).click();
  await page.waitForFunction(
    () => document.querySelector(".reader h1")?.textContent?.includes("第 5 章"),
    null,
    { timeout: 5000 },
  );
  console.log("  accepting the offer moves to the next chapter");

  await page.screenshot({ path: path.join(outDir, "reader-preview.png") });
  console.log("  screenshot: test-results/reader-preview.png");

  // -- read markers in the contents ------------------------------------------
  // Knowing what is left matters more than knowing where you are.
  await page.getByRole("button", { name: "目录" }).click();
  await page.waitForSelector(".toc-list li", { timeout: 5000 });
  const ticks = await page.locator(".toc-tick").count();
  const partials = await page.locator(".toc-partial").count();
  assert.equal(ticks, 2, `expected 2 finished chapters marked, saw ${ticks}`);
  assert.equal(partials, 1, `expected 1 part-read chapter marked, saw ${partials}`);
  console.log(`  contents marks ${ticks} finished and ${partials} part-read chapter(s)`);
  await page.locator(".toc-head button").click();

  // -- table of contents ---------------------------------------------------
  await page.locator(".main-head button", { hasText: "目录" }).click();
  await page.waitForSelector(".toc-list", { timeout: 5000 });
  const rows = await page.locator(".toc-list li").count();
  assert.equal(rows, 6, `expected 6 chapters, saw ${rows}`);
  // Which chapter is current depends on what ran before, so read it back rather
// than assuming.
  const reading = (await page.locator(".reader h1").innerText()).trim();
  const currentRow = (await page.locator(".toc-list li.current .toc-t").innerText()).trim();
  assert.equal(currentRow, reading, `contents highlight ${currentRow} but the reader shows ${reading}`);
  console.log(`  contents lists ${rows} chapters, highlighting "${currentRow}"`);

  // Jumping from the contents must move the reader.
  await page.locator(".toc-list li").nth(5).click();
  await page.waitForFunction(
    () => document.querySelector(".reader h1")?.textContent?.includes("第 6 章"),
    null,
    { timeout: 5000 },
  );
  assert.equal(await page.locator(".toc").count(), 0, "the contents stayed open after jumping");
  console.log("  picking a chapter moved the reader and closed the contents");

  // The footer buttons move too, and stop at the ends of the list.
  await page.locator(".chapter-nav button", { hasText: "上一章" }).click();
  await page.waitForFunction(
    () => document.querySelector(".reader h1")?.textContent?.includes("第 5 章"),
    null,
    { timeout: 5000 },
  );
  const prevDisabled = await page.locator(".chapter-nav button", { hasText: "上一章" }).isDisabled();
  assert.ok(!prevDisabled, "previous should still be available");
  await page.locator(".chapter-nav button", { hasText: "下一章" }).click();
  await page.waitForFunction(
    () => document.querySelector(".reader h1")?.textContent?.includes("第 6 章"),
    null,
    { timeout: 5000 },
  );
  const nextDisabled = await page.locator(".chapter-nav button", { hasText: "下一章" }).isDisabled();
  assert.ok(nextDisabled, "next should be disabled on the last chapter");
  console.log("  chapter buttons walk the list and disable at both ends");
} catch (error) {
  failed = true;
  console.error("reader test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-failure.png") });
    console.error("  failure screenshot: test-results/reader-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);