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

  await page.screenshot({ path: path.join(outDir, "reader-preview.png") });
  console.log("  screenshot: test-results/reader-preview.png");
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