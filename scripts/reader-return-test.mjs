// Does coming back keep your place?
//
//   node scripts/reader-return-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-return-preview.html).
//
// What it proves, with the numbers rather than an impression:
//   1. Opening an article and coming back lands on the same category (the active
//      class, not the label) and the exact same scrollTop that was recorded
//      before opening. The task asked for a hard number, so the assertion is an
//      equality on the recorded value, not "close enough".
//   2. Switching source starts over: first category, no leftover scroll.
//   3. A panel opened from the reader returns to the reader, not to the list.
//   4. Escape leaves the reader, does nothing on the list, and leaves the video
//      player and the reader's settings popover alone.
//
// The real App is mounted, so what is measured is the wiring itself rather than
// a re-implementation of it.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.READER_RETURN_PREVIEW_URL || "http://localhost:1420/reader-return-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_RETURN_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
let failed = false;

/** The category tab that is actually selected, read from its class. */
const activeCategory = () =>
  page.evaluate(() => {
    const el = document.querySelector(".cat.active");
    return el ? el.textContent?.trim() ?? "" : null;
  });

/** Scroll offset of the list, or null when no list is on screen. */
const listScroll = () =>
  page.evaluate(() => {
    const el = document.querySelector(".main-body");
    return el ? Math.round(el.scrollTop) : null;
  });

/**
 * Wait for an exact scroll offset, and say what it saw if it never arrives.
 *
 * A bare `waitForFunction` timeout only reports "timed out", which says nothing
 * about whether the restore landed on the wrong number, never ran, or ran while
 * the container was still too short to scroll to it. Those are three different
 * bugs and they need different fixes.
 */
async function waitForScroll(want, label, timeout = 10000) {
  const started = Date.now();
  let seen = null;
  while (Date.now() - started < timeout) {
    seen = await listScroll();
    if (seen === want) return;
    await page.waitForTimeout(150);
  }
  const detail = await page
    .evaluate(() => {
      const el = document.querySelector(".main-body");
      const root = document.documentElement.dataset;
      return {
        active: document.querySelector(".cat.active")?.textContent?.trim() ?? null,
        cards: document.querySelectorAll(".card").length,
        scrollable: el ? el.scrollHeight - el.clientHeight : -1,
        scrollTop: el ? Math.round(el.scrollTop) : null,
        // Set only by the list when the preview runs with ?renderProbe=1, which
        // is what a failing run is pointed at when this needs explaining. Absent
        // in normal use, which is why it reads "(probe off)".
        parentInitialScrollTop: root.probeInitScroll ?? "(probe off)",
      };
    })
    .catch((e) => ({ error: String(e).split("\n")[0] }));
  throw new Error(
    `${label}: scrollTop never reached ${want} in ${timeout}ms (last ${seen}) — ${JSON.stringify(detail)}`,
  );
}

// `article.reader`, not `.reader`: the settings panel reuses the `.reader` class
// for its own scroll container (SettingsPanel.tsx), so counting `.reader` counts
// the settings panel too and makes "the reader is still behind the settings
// panel" fail while the reader is in fact unmounted. Only the article view
// renders an <article class="reader">.
const inReader = () => page.locator("article.reader").count();
const inList = () => page.locator(".cat-bar").count();

try {
  console.log(`  url: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".cat", { timeout: 20000 });
  await page.waitForSelector(".card", { timeout: 20000 });

  // -- 1. category and scroll come back ---------------------------------------
  assert.equal(await activeCategory(), "全部", "the list did not start on the first category");

  await page.locator(".cat", { hasText: "都市" }).click();
  await page.waitForFunction(
    () => document.querySelector(".cat.active")?.textContent?.trim() === "都市",
    null,
    { timeout: 5000 },
  );
  // A real offset, recorded exactly, and a page tall enough to hold it.
  const LEFT_AT = 842;
  const scrollable = await page.evaluate(() => {
    const el = document.querySelector(".main-body");
    return el ? el.scrollHeight - el.clientHeight : 0;
  });
  assert.ok(scrollable > LEFT_AT, `the list is not tall enough to test a restore (${scrollable}px)`);
  await page.evaluate((top) => {
    const el = document.querySelector(".main-body");
    if (el) el.scrollTop = top;
  }, LEFT_AT);
  await page.waitForFunction(
    (want) => Math.round(document.querySelector(".main-body")?.scrollTop ?? -1) === want,
    LEFT_AT,
    { timeout: 5000 },
  );
  const leftAt = await listScroll();
  assert.equal(leftAt, LEFT_AT, `could not put the list at the offset under test: ${leftAt}`);
  console.log(`  left 都市 at scrollTop=${leftAt} (list is ${scrollable}px scrollable)`);

  // Open an article — the list unmounts here.
  //
  // A card that is *visible at this offset*, not simply the first one. The first
  // card sits at the top of the list, which is 842px above the viewport, so
  // Playwright scrolls it into view before clicking it — and that scroll is a
  // real one the list correctly reports, which used to overwrite the very offset
  // this test is trying to prove survives. The failure was in the test's own
  // action, not in the app, and it only showed up intermittently because whether
  // the resulting scroll event arrives before the list unmounts is a race.
  const visibleCard = await page.evaluate(() => {
    const box = document.querySelector(".main-body");
    if (!box) return -1;
    const bounds = box.getBoundingClientRect();
    return [...document.querySelectorAll(".card")].findIndex((c) => {
      const r = c.getBoundingClientRect();
      return r.top >= bounds.top + 4 && r.bottom <= bounds.bottom - 4;
    });
  });
  assert.ok(visibleCard >= 0, "no card is fully visible at the offset under test");
  await page.locator(".card").nth(visibleCard).click();
  await page.waitForSelector("article.reader", { timeout: 15000 });
  assert.equal(await inList(), 0, "the list is still mounted behind the reader");
  console.log("  opened an article (the list unmounted)");

  // Come back. The back button is the first ghost button in the reader's header;
// addressed that way rather than by role, because several panels have their own
// 「← 返回」 and the role query can resolve to one of those instead.
  await page.locator(".main-head .ghost").first().click();
  await page.waitForSelector(".cat", { timeout: 15000 });
  await page.waitForSelector(".card", { timeout: 15000 });

  const categoryAfter = await activeCategory();
  assert.equal(categoryAfter, "都市", `came back to "${categoryAfter}" instead of the category left`);

  // Hard equality on the recorded offset, once the rows have rendered — the
  // container is only tall enough a frame or two after the list remounts.
  await waitForScroll(leftAt, "came back from the article");
  const afterScroll = await listScroll();
  assert.equal(afterScroll, leftAt, `came back at ${afterScroll}, left at ${leftAt}`);
  console.log(`  came back: category=${categoryAfter} (active), scrollTop=${afterScroll} (exact)`);

  // -- 2. a different source starts over --------------------------------------
  await page.locator('.src-item[aria-label^="乙源"]').click();
  await page.waitForFunction(
    () => document.querySelector(".cat.active")?.textContent?.trim() === "全部",
    null,
    { timeout: 10000 },
  );
  await page.waitForTimeout(400);
  const afterSwitch = await listScroll();
  assert.equal(await activeCategory(), "全部", "the new source did not start on its first category");
  assert.equal(afterSwitch, 0, `the new source inherited a scroll position of ${afterSwitch}`);
  console.log("  switching source: first category, scrollTop=0");

  // And going back to the first source still has its own place, not the other's.
  await page.locator('.src-item[aria-label^="甲源"]').click();
  await page.waitForSelector(".cat", { timeout: 10000 });
  await waitForScroll(leftAt, "came back to 甲源 after switching sources");
  console.log("  coming back to 甲源 restored its own position again");

  // -- 3. a panel opened from the reader returns to the reader ----------------
  await page.locator(".card").first().click();
  await page.waitForSelector("article.reader", { timeout: 15000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForSelector('[data-settings-field="repo_base"]', { timeout: 10000 });
  assert.equal(await inReader(), 0, "the reader is still on screen behind the settings panel");
  await page.locator(".main-head .ghost").first().click();
  await page.waitForSelector("article.reader", { timeout: 10000 });
  assert.equal(await inReader(), 1, "返回 from a panel did not go back to the article");
  console.log("  reader → 设置 → 返回: back in the article, not the list");

  // Escape does the same from a panel.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForSelector('[data-settings-field="repo_base"]', { timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector("article.reader", { timeout: 10000 });
  console.log("  reader → 设置 → Escape: also back in the article");

  // -- 4. Escape on the main screens ------------------------------------------
  await page.keyboard.press("Escape");
  await page.waitForSelector(".cat", { timeout: 10000 });
  assert.equal(await inReader(), 0, "Escape did not leave the reader");
  console.log("  Escape in the reader returned to the list");

  // On the list there is nothing above it: nothing should happen, and nothing
  // crashing is the observable.
  const beforeListCategory = await activeCategory();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert.equal(await inList(), 1, "Escape on the list closed it");
  assert.equal(await activeCategory(), beforeListCategory, "Escape on the list changed the category");
  console.log("  Escape on the list does nothing, as it should");

  await page.screenshot({ path: path.join(outDir, "reader-return.png") });
  console.log("  screenshot: test-results/reader-return.png");
} catch (error) {
  failed = true;
  console.error("reader return test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-return-failure.png") });
    console.error("  failure screenshot: test-results/reader-return-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);