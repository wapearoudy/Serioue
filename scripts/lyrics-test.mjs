// Drives the real MusicPlayer, with real `.lrc` files, against real audio.
//
//   node scripts/lyrics-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:audio` already generated.
//
// What it proves:
//   - a lyric file on the page reaches the player and is parsed
//   - the current line follows playback rather than staying at the top
//   - clicking a line seeks to it
//   - the messy shapes real files use (two timestamps per line, `:` as the
//     fraction separator, metadata tags, a bracket inside the text) are handled
//   - a track with no lyric file simply has no panel

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.LYRICS_PREVIEW_URL || "http://localhost:1420/music-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.LYRICS_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
let failed = false;

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

  // -- the panel appears -----------------------------------------------------
  await page.waitForSelector(".music-lyrics", { timeout: 10000 });
  const firstCount = await page.locator(".music-lyrics button").count();
  console.log(`  lyric panel rendered with ${firstCount} lines`);
  assert.equal(firstCount, 19, `expected 19 lyric lines, got ${firstCount}`);

  // Metadata tags must not become a lyric line.
  const texts = await page.locator(".music-lyrics button").allInnerTexts();
  for (const t of texts) {
    assert.ok(!/^\[(ti|ar|al|by|offset):/i.test(t.trim()), `metadata leaked into lyrics: ${t}`);
  }
  assert.ok(texts[0].startsWith("第一行歌词"), `wrong first line: ${texts[0]}`);

  // -- it follows playback ---------------------------------------------------
  // The first line is stamped 00:00.00, so it is legitimately showing before
  // playback starts.
  const before = (await page.locator(".music-lyrics button.now").innerText()).trim();
  assert.ok(before.startsWith("第一行歌词"), `wrong line showing at t=0: ${before}`);
  console.log(`  at rest the panel shows: ${before}`);

  await page.evaluate(async () => {
    const a = document.querySelector(".music audio");
    await a.play();
  });
  // Wait until playback is genuinely running before waiting for a later line,
  // so a slow start cannot masquerade as a broken lyric panel.
  await page.waitForFunction(
    () => document.querySelector(".music audio").currentTime > 0.05,
    null,
    { timeout: 15000 },
  );
  // Line 12 sits at 4.4s, comfortably inside the 8s fixture.
  // Wait for a line further down the sheet, so the highlight has actually moved.
  await page.waitForFunction(
    () => {
      const now = document.querySelector(".music-lyrics button.now");
      return now !== null && now.textContent.includes("第 12 行");
    },
    null,
    { timeout: 15000 },
  );
  const current = (await page.locator(".music-lyrics button.now").innerText()).trim();
  console.log(`  current line follows playback: ${current}`);
  assert.equal(await page.locator(".music-lyrics button.now").count(), 1, "not exactly one line is current");

  // The panel is scrollable, and the current line must be inside the visible
  // area — a lyric column scrolled past the song is worse than none.
  const scroll = await page.evaluate(() => {
    const el = document.querySelector(".music-lyrics");
    const now = document.querySelector(".music-lyrics button.now");
    const box = el.getBoundingClientRect();
    const line = now.getBoundingClientRect();
    return {
      top: el.scrollTop,
      height: el.clientHeight,
      scrollHeight: el.scrollHeight,
      visible: line.top >= box.top - 1 && line.bottom <= box.bottom + 1,
    };
  });
  assert.ok(scroll.scrollHeight > scroll.height, "the lyric panel did not overflow, so nothing was tested");
  assert.ok(scroll.top > 0, `the panel did not follow the song (scrollTop ${scroll.top})`);
  assert.ok(scroll.visible, "the current line scrolled out of view");
  console.log(
    `  panel followed the song to ${scroll.top}px of ${scroll.scrollHeight - scroll.height}px, ` +
      `current line in view`,
  );

  await page.screenshot({ path: path.join(outDir, "lyrics.png") });
  console.log("  screenshot: test-results/lyrics.png");

  await page.evaluate(() => document.querySelector(".music audio").pause());

  // -- clicking a line seeks -------------------------------------------------
  // The generator stamps lines 0.4s apart, so the fifth line is at 1.60s.
  const target = 4;
  await page.locator(".music-lyrics button").nth(target).click();
  const seeked = await page.evaluate(() => document.querySelector(".music audio").currentTime);
  assert.ok(Math.abs(seeked - 1.6) < 0.03, `clicking a line seeked to ${seeked}, expected ~1.60`);
  console.log(`  clicking line ${target + 1} seeked to ${seeked.toFixed(2)}s`);

  // -- the messy file --------------------------------------------------------
  await page.locator(".music-queue li").nth(1).click();
  await page.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll(".music-lyrics button")];
      return buttons.length > 0 && buttons.some((b) => b.textContent.includes("两个时间戳"));
    },
    null,
    { timeout: 10000 },
  );
  const messy = await page.locator(".music-lyrics button").allInnerTexts();
  console.log(`  messy file parsed to ${messy.length} lines: ${JSON.stringify(messy)}`);
  // Sorted by time: 0.50, 0.75, 1.00, 1.60, 2.00.
  assert.equal(messy.length, 5, `expected 5 lines from the messy file, got ${messy.length}`);
  assert.equal(messy[0], "同一行带两个时间戳", "first timestamp of a doubled line not taken");
  assert.equal(messy[1], "冒号也可以当小数点", "`:` fraction separator not parsed");
  assert.equal(messy[2], "同一行带两个时间戳", "second timestamp of a doubled line not taken or misordered");
  assert.equal(messy[3], "♪", "an untimed instrumental gap should render as a note");
  assert.ok(
    messy[4].includes("方括号 [在这里] 不该被当成时间戳"),
    `a bracket inside the text broke the line: ${messy[4]}`,
  );
  assert.ok(
    !messy.some((t) => t.includes("没有时间戳")),
    "a line with no timestamp was kept",
  );

  // -- a track without lyrics ------------------------------------------------
  await page.locator(".music-queue li").nth(2).click();
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator(".music-lyrics").count(),
    0,
    "a track with no lyric file should have no panel",
  );
  console.log("  a track with no lyric file shows no panel");
} catch (error) {
  failed = true;
  console.error("lyrics test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "lyrics-failure.png") });
    console.error("  failure screenshot: test-results/lyrics-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);