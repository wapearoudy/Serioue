// Does coming back to an article keep your place *inside* the article?
//
//   node scripts/reader-position-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-return-preview.html).
//
// reader-return-test.mjs already pins the list side (category + list scroll).
// This one pins the other half of "coming back": the position inside the
// article, driven through the real path — read to the middle, press 「← 返回」,
// open the same entry again — with the assertion on the real `scrollTop` of the
// reader's scroll container, never on React state.
//
// It measures three things:
//   1. same article: read to 60% → 返回 → open it again → must still be at 60%
//   2. a *different* article must start at the top (no crossing over)
//   3. a full page reload (the browser's stand-in for a process restart) must
//      still restore the position
//
// The reading-position store is the app's own: the preview harness stubs
// `get_progress`/`save_progress` to a constant 0, which would make every
// reopening start at the top no matter what the reader does — so this script
// traps those two commands before the app starts and implements them against
// the same localStorage store the dev stub uses. Every call is logged in
// `window.__posProbe`, which is what tells "the unmount overwrote the position"
// apart from "the restore never ran".

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.READER_POSITION_PREVIEW_URL || "http://localhost:1420/reader-return-preview.html";

/** Where the reader is told to stop. 60% is the number in the bug report. */
const TARGET = 0.6;
const TOLERANCE = 0.03;

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_POSITION_TEST_CHANNEL || "msedge",
});
// One window size for the whole run. Deliberately short: the preview's article
// is a dozen short paragraphs, so a normal window leaves too little travel for
// a position to mean anything — and at 60% of a small range the reader's own
// 「本章已读完 · 下一章」 offer appears (it triggers within 160px of the end),
// which shrinks the container and moves the very ratio under test. At this size
// the article scrolls ~460px, so 60% is genuinely mid-article.
const page = await browser.newPage({ viewport: { width: 1200, height: 440 } });
let failed = false;

/** Load the list and put the position store on top of the harness's stub. */
async function loadList() {
  await page.waitForSelector(".cat", { timeout: 20000 });
  await page.waitForSelector(".card", { timeout: 20000 });
  await installProgressStore();
}

/**
 * Put a real reading-position store in front of the app's invoke().
 *
 * Not an init script: /reader-return-preview.html installs its own invoke
 * wrapper at module scope, over whatever an init script leaves behind, and that
 * wrapper answers `save_progress` with null — so an init-script trap sits
 * *underneath* it and never sees a single call. Wrapping after the page has
 * loaded puts this one on top, where the app's calls arrive.
 *
 * The store is the same localStorage map the dev stub uses, so a reloaded page
 * (the browser's stand-in for a process restart) finds it again. Every call is
 * logged in `window.__posProbe`, which is what tells "the unmount overwrote the
 * position" apart from "the restore never ran".
 */
async function installProgressStore() {
  await page.evaluate(() => {
    const KEY = "serious-dev-store";
    const log = { saves: [], gets: [] };
    window.__posProbe = log;
    const readStore = () => {
      try {
        return JSON.parse(localStorage.getItem(KEY) ?? "{}");
      } catch {
        return {};
      }
    };
    const progressOf = () => readStore().progress ?? {};
    const writeProgress = (url, ratio) => {
      const store = readStore();
      localStorage.setItem(KEY, JSON.stringify({ ...store, progress: { ...progressOf(), [url]: ratio } }));
    };

    const inner = window.__TAURI_INTERNALS__.invoke;
    if (inner.__positionStore) return;
    const wrapper = async (cmd, args = {}) => {
      if (cmd === "save_progress") {
        const ratio = Number(args.ratio) || 0;
        writeProgress(String(args.url), ratio);
        log.saves.push({ url: String(args.url), ratio: Number(ratio.toFixed(4)) });
        return null;
      }
      if (cmd === "get_progress") {
        const ratio = progressOf()[String(args.url)] ?? 0;
        log.gets.push({ url: String(args.url), ratio });
        return ratio;
      }
      if (cmd === "get_progress_many") {
        const progress = progressOf();
        const out = {};
        for (const u of args.urls ?? []) out[u] = progress[u] ?? 0;
        return out;
      }
      return inner(cmd, args);
    };
    wrapper.__positionStore = true;
    window.__TAURI_INTERNALS__.invoke = wrapper;
  });
}

/** The reader's scroll container, read the way a reader would see it. */
const readerState = () =>
  page.evaluate(() => {
    const el = document.querySelector(".main-body");
    const inReader = !!document.querySelector("article.reader");
    if (!el) return { inReader, scrollTop: null, scrollable: null, ratio: null };
    const scrollable = el.scrollHeight - el.clientHeight;
    return {
      inReader,
      scrollTop: Math.round(el.scrollTop),
      scrollable,
      ratio: scrollable > 1 ? Number((el.scrollTop / scrollable).toFixed(4)) : 0,
    };
  });

const probe = () => page.evaluate(() => window.__posProbe);
const storedFor = (u) =>
  page.evaluate((key) => {
    try {
      const store = JSON.parse(localStorage.getItem("serious-dev-store") ?? "{}");
      return (store.progress ?? {})[key] ?? null;
    } catch {
      return null;
    }
  }, u);

/**
 * Open a list entry by position.
 *
 * By position, not by title: a card's text is cut across child elements, and
 * matching a whitespace-normalised copy of it buys a timeout instead of a
 * measurement. Playwright scrolls the card into view before clicking, which
 * moves the *list* — that is the list's business (reader-return-test.mjs pins
 * it) and changes nothing about the article position measured here.
 */
async function openCard(index = 0) {
  const title = (await page.locator(".card").nth(index).innerText()).replace(/\s+/g, " ").trim();
  await page.locator(".card").nth(index).click();
  await page.waitForSelector("article.reader", { timeout: 15000 });
  return { index, title };
}

/** The URL the reader most recently asked for a position (its own identity). */
async function lastGetUrl(timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const gets = (await probe()).gets;
    if (gets.length) return gets.at(-1).url;
    await page.waitForTimeout(100);
  }
  throw new Error("the reader never asked for its position (no get_progress call)");
}

/** Wait until the reader has a real, scrollable body. */
async function waitScrollable(min = 250, timeout = 15000) {
  const started = Date.now();
  let seen = null;
  while (Date.now() - started < timeout) {
    seen = await readerState();
    if (seen.scrollable !== null && seen.scrollable > min) return seen;
    await page.waitForTimeout(100);
  }
  throw new Error(`the reader never became scrollable past ${min}px (${JSON.stringify(seen)})`);
}

/**
 * Make the article tall enough that a position is a real number.
 *
 * The preview's article is a dozen short paragraphs, which at a normal window
 * height leaves about a hundred pixels of travel — enough to be technically
 * scrollable and useless as a measurement. The window is short instead of the
 * font being large: /reader-return-preview.html answers `get_settings` with a
 * constant, so a font raised through the Aa control comes back at 17px after a
 * reload — and the reload is exactly the case that must be compared against the
 * same layout.
 */

/**
 * Wait for a ratio, and on failure say what actually happened: where the scroll
 * ended up, what is stored on disk, and every save/get the app performed.
 */
async function waitRatio(want, label, timeout = 6000) {
  const started = Date.now();
  let seen = null;
  while (Date.now() - started < timeout) {
    seen = await readerState();
    if (seen.ratio !== null && Math.abs(seen.ratio - want) <= TOLERANCE) return seen;
    await page.waitForTimeout(100);
  }
  const title = await page.evaluate(
    () => document.querySelector(".main-title")?.textContent?.trim() ?? "",
  );
  const saves = (await probe()).saves;
  throw new Error(
    `${label}: expected to land at ${(want * 100).toFixed(0)}% (±${TOLERANCE * 100}%), ` +
      `ended at ${seen.ratio === null ? "no container" : `${(seen.ratio * 100).toFixed(1)}%`} ` +
      `(scrollTop=${seen.scrollTop}, scrollable=${seen.scrollable}, article="${title}"); ` +
      `save_progress calls: ${JSON.stringify(saves)}`,
  );
}

async function backToList() {
  await page.locator(".main-head .ghost").first().click();
  await page.waitForSelector(".cat", { timeout: 15000 });
  await page.waitForSelector(".card", { timeout: 15000 });
}

try {
  console.log(`  url: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await loadList();

  // -- 1. same article --------------------------------------------------------
  const cardA = await openCard(0);
  const first = await waitScrollable();
  const urlA = await lastGetUrl();
  console.log(`  opened "${cardA.title}" (scrollable ${first.scrollable}px, ${urlA})`);

  await page.evaluate((target) => {
    const el = document.querySelector(".main-body");
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * target;
  }, TARGET);
  await page.waitForTimeout(400);
  const readTo = await readerState();
  assert.ok(
    Math.abs(readTo.ratio - TARGET) <= TOLERANCE,
    `could not put the reader at ${TARGET}: ${JSON.stringify(readTo)}`,
  );
  // The measurement only means something while the article is longer than the
  // viewport all the way past the point under test: within 160px of the end the
  // reader offers the next chapter, the offer bar takes vertical space, and the
  // ratio legitimately moves after it is read. Fail loudly instead of measuring
  // that.
  assert.ok(
    readTo.scrollable - readTo.scrollTop > 165,
    `the position under test is inside the end-of-chapter offer zone ` +
      `(${readTo.scrollable - readTo.scrollTop}px of article left, the offer triggers under 160px)`,
  );
  console.log(
    `  read to scrollTop=${readTo.scrollTop} of ${readTo.scrollable} = ${(readTo.ratio * 100).toFixed(1)}% ` +
      `(${readTo.scrollable - readTo.scrollTop}px left below it)`,
  );

  // Let the throttled save run, so what is measured afterwards is the unmount
  // behaviour and not "nothing was ever written".
  let savesWhileReading = [];
  const saveDeadline = Date.now() + 5000;
  while (Date.now() < saveDeadline) {
    savesWhileReading = (await probe()).saves;
    if (savesWhileReading.some((s) => s.ratio > 0.4)) break;
    await page.waitForTimeout(150);
  }
  console.log(
    `  while reading at 60%: ${savesWhileReading.length} save_progress call(s) ${JSON.stringify(savesWhileReading)}`,
  );
  assert.ok(
    savesWhileReading.some((s) => s.ratio > 0.4),
    `reading did not save the position it was at: ${JSON.stringify(savesWhileReading)}`,
  );

  await backToList();
  const savesAfterLeaving = (await probe()).saves;
  const storedA = await storedFor(urlA);
  console.log(
    `  after 返回: save_progress calls ${JSON.stringify(savesAfterLeaving.map((s) => s.ratio))}, ` +
      `stored for that article = ${storedA}`,
  );
  assert.ok(
    storedA !== null && Math.abs(storedA - TARGET) <= TOLERANCE,
    `leaving the article overwrote the saved position: stored ${storedA} ` +
      `(expected ~${TARGET}); save_progress calls ${JSON.stringify(savesAfterLeaving)}`,
  );

  await openCard(cardA.index);
  const reopenedUrl = await lastGetUrl();
  assert.equal(reopenedUrl, urlA, `reopening opened a different article (${reopenedUrl} vs ${urlA})`);
  const reopened = await waitRatio(TARGET, "reopening the same article");
  console.log(
    `  reopened "${cardA.title}": scrollTop=${reopened.scrollTop} = ${(reopened.ratio * 100).toFixed(1)}%`,
  );
  await backToList();

  // -- 2. a different article starts at the top -------------------------------
  const cardB = await openCard(1);
  const other = await waitScrollable();
  const urlB = await lastGetUrl();
  assert.notEqual(urlB, urlA, `the second card is the same article as the first (${urlB})`);
  await page.waitForTimeout(600);
  const otherNow = await readerState();
  assert.ok(
    otherNow.ratio <= 0.02,
    `a different article inherited a position: "${cardB.title}" opened at ` +
      `${(otherNow.ratio * 100).toFixed(1)}% (scrollTop=${otherNow.scrollTop}, scrollable=${other.scrollable})`,
  );
  console.log(
    `  different article "${cardB.title}" (${urlB}): scrollTop=${otherNow.scrollTop} of ` +
      `${other.scrollable} = ${(otherNow.ratio * 100).toFixed(1)}%, opens at the top`,
  );
  await backToList();

  // -- 3. after a restart -----------------------------------------------------
  // A full page load is the browser's version of closing and reopening the app:
  // fresh JS, fresh refs, the same store.
  await page.reload({ waitUntil: "domcontentloaded" });
  await loadList();
  await openCard(cardA.index);
  const restartUrl = await lastGetUrl();
  assert.equal(restartUrl, urlA, `after the reload a different article opened (${restartUrl})`);
  const afterRestart = await waitRatio(TARGET, "after a reload");
  console.log(
    `  after reload: "${cardA.title}" (${restartUrl}) at scrollTop=${afterRestart.scrollTop} = ` +
      `${(afterRestart.ratio * 100).toFixed(1)}%`,
  );

  // -- the store, in one place ------------------------------------------------
  const finalProbe = await probe();
  console.log(
    `  get_progress calls: ${finalProbe.gets.length}, save_progress calls: ${finalProbe.saves.length}`,
  );
  console.log(
    `  save_progress values for "${urlA}": ` +
      JSON.stringify(finalProbe.saves.filter((s) => s.url === urlA).map((s) => s.ratio)),
  );

  await page.screenshot({ path: path.join(outDir, "reader-position.png") });
  console.log("  screenshot: test-results/reader-position.png");
} catch (error) {
  failed = true;
  console.error("reader position test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-position-failure.png") });
    console.error("  failure screenshot: test-results/reader-position-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
