// Drives the real MusicPlayer in a real browser (Chromium via Playwright)
// against real audio files.
//
//   node scripts/music-player-test.mjs
//
// Verifies the controls actually work rather than merely rendering: playback
// advances, the seek bar moves, next/previous change track, and the queue
// highlights the playing row.
//
// Needs `pnpm dev` running (it serves /music-preview.html and /demo/*.wav).

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system
  // Edge is the same engine and is always present on Windows.
  channel: process.env.MUSIC_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
let failed = false;

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".music", { timeout: 15000 });

  const queueRows = await page.locator(".music-queue li").count();
  assert.equal(queueRows, 3, `expected 3 queued tracks, saw ${queueRows}`);
  console.log(`  queue lists ${queueRows} track(s)`);

  const playButton = page.locator(".music-play");
  assert.equal((await playButton.innerText()).trim(), "▶", "should start paused");
  assert.equal(await page.locator(".music-queue li.playing").count(), 1);

  // Press play and wait for the position to genuinely advance. The time label
  // reads "position / duration", so only the left half counts — matching the
  // duration instead would pass instantly.
  await playButton.click();
  await page.waitForFunction(
    () => {
      const label = document.querySelector(".music-time")?.textContent ?? "";
      const pos = label.split("/")[0].trim();
      const [m, s] = pos.split(":").map(Number);
      return Number.isFinite(m) && Number.isFinite(s) && (m * 60 + s) > 0.4;
    },
    null,
    { timeout: 15000 },
  );
  const timeAfterPlay = await page.locator(".music-time").innerText();
  console.log(`  playback advanced to ${timeAfterPlay.replace(/\s+/g, " ")}`);
  assert.equal((await playButton.innerText()).trim(), "⏸", "play button should show pause");

  // The seek bar must reflect real progress.
  const seekValue = await page.locator(".music-seek input").inputValue();
  assert.ok(Number(seekValue) > 0, `seek bar did not advance (${seekValue})`);

  // Next track changes the highlighted row. The button's accessible name is its
  // glyph, so locate it by its title instead.
  await page.locator('button[title*="下一首"]').click();
  await page.waitForFunction(
    () => document.querySelector(".music-queue li.playing .t")?.textContent?.includes("第二首"),
    { timeout: 10000 },
  );
  console.log("  next track moved the queue highlight");

  // Previous restarts the current track first, like every music player.
  await page.locator('button[title*="上一首"]').click();
  await page.waitForFunction(
    () => document.querySelector(".music-queue li.playing .t")?.textContent?.includes("第一首"),
    { timeout: 10000 },
  );
  console.log("  previous track restored the first row");

  // Clicking a queue row jumps straight to it.
  await page.locator(".music-queue li").nth(2).click();
  await page.waitForFunction(
    () => document.querySelector(".music-queue li.playing .t")?.textContent?.includes("第三首"),
    { timeout: 10000 },
  );
  console.log("  clicking a queue row switched track");

  // Space toggles playback.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => document.querySelector(".music-play")?.textContent?.trim() === "▶",
    { timeout: 10000 },
  );
  console.log("  space bar paused playback");

  // A volume slider must move the element's own volume.
  await page.locator(".music-volume").fill("0.35");
  const vol = await page.evaluate(() => {
    const el = document.querySelector("audio");
    return el ? el.volume : -1;
  });
  assert.ok(Math.abs(vol - 0.35) < 0.01, `volume not applied to the element (${vol})`);
  console.log(`  volume slider set the element to ${vol}`);

  await page.screenshot({ path: path.join(outDir, "music-player.png") });
  console.log("  screenshot: test-results/music-player.png");
} catch (error) {
  failed = true;
  console.error("music player test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "music-player-failure.png") });
    console.error("  failure screenshot: test-results/music-player-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);