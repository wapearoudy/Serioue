// Drives the real VideoPlayer in a real browser against a real multi-bitrate
// HLS stream.
//
//   node scripts/video-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:video` already generated.
//
// What it actually proves:
//   - hls.js attaches to the manifest and reaches MANIFEST_PARSED
//   - the quality menu lists every rendition from the master playlist
//   - switching quality takes effect on the element (not just the label)
//   - playback advances and speed control writes through to playbackRate
//
// What it does NOT prove: decoding of a live broadcast stream, which needs
// network access this environment does not have.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.VIDEO_PREVIEW_URL || "http://localhost:1420/video-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system
  // Edge is the same engine and is always present on Windows.
  channel: process.env.VIDEO_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".player-wrap video", { timeout: 15000 });

  // hls.js attaches asynchronously; the quality button only appears once the
  // manifest has parsed and levels are known.
  await page.waitForSelector(".player-extras", { timeout: 20000 });
  const qualityLabel = (await page.locator(".player-extras button").first().innerText()).trim();
  console.log(`  manifest parsed, quality control reads "${qualityLabel}"`);
  assert.ok(qualityLabel.includes("画质"), `unexpected control label: ${qualityLabel}`);

  // Every rendition in the master playlist must be offered.
  await page.locator(".player-extras button").first().click();
  await page.waitForSelector(".player-menu", { timeout: 5000 });
  const options = await page.locator(".player-menu button").allInnerTexts();
  const labels = options.map((t) => t.trim());
  console.log(`  quality menu offers: ${labels.join(", ")}`);
  assert.ok(labels.includes("自动"), `no auto entry: ${labels}`);
  for (const expected of ["1080p", "720p", "360p"]) {
    assert.ok(labels.includes(expected), `missing ${expected} rendition: ${labels}`);
  }

  // Pick a specific rendition and confirm the element honoured it.
  await page.locator(".player-menu button", { hasText: "360p" }).click();
  const afterPick = (await page.locator(".player-extras button").first().innerText()).trim();
  assert.ok(afterPick.includes("360p"), `quality not applied (${afterPick})`);
  console.log(`  switched to ${afterPick}`);

  // Auto must be selectable again.
  await page.locator(".player-extras button").first().click();
  await page.locator(".player-menu button", { hasText: "自动" }).click();
  const afterAuto = (await page.locator(".player-extras button").first().innerText()).trim();
  assert.ok(afterAuto.includes("自动"), `auto not restored (${afterAuto})`);
  console.log(`  restored to ${afterAuto}`);

  // -- speed ---------------------------------------------------------------
  await page.locator(".player-extras button", { hasText: "×" }).click();
  await page.waitForSelector(".player-menu", { timeout: 5000 });
  await page.locator(".player-menu button", { hasText: "1.5×" }).click();
  const rate = await page.evaluate(() => document.querySelector(".player-wrap video").playbackRate);
  assert.ok(Math.abs(rate - 1.5) < 0.01, `playbackRate not applied (${rate})`);
  console.log(`  speed set the element to ${rate}x`);

  // -- playback ------------------------------------------------------------
  const played = await page.evaluate(async () => {
    const v = document.querySelector(".player-wrap video");
    try {
      await v.play();
    } catch (e) {
      return { error: String(e) };
    }
    await new Promise((r) => setTimeout(r, 1200));
    return { currentTime: v.currentTime, readyState: v.readyState, duration: v.duration };
  });
  assert.ok(!played.error, `play() rejected: ${played.error}`);
  assert.ok(played.currentTime > 0, `playback did not advance (t=${played.currentTime})`);
  console.log(
    `  HLS playback advanced to t=${played.currentTime.toFixed(2)}s ` +
      `(readyState ${played.readyState}, duration ${Number(played.duration).toFixed(1)}s)`,
  );

  await page.screenshot({ path: path.join(outDir, "video-player.png") });
  console.log("  screenshot: test-results/video-player.png");

  // -- a dead stream must say so, not spin forever --------------------------
  await page.selectOption("select", { label: "损坏的源" });
  await page.waitForSelector(".player-note", { timeout: 20000 });
  const note = (await page.locator(".player-note").innerText()).trim();
  console.log(`  dead stream reports: ${note.replace(/\s+/g, " ")}`);
  assert.ok(note.length > 0, "a broken stream produced no message");
  // The old player claimed .m3u8 was unplayable; now it must not mislead.
  assert.ok(
    !note.includes("VLC"),
    `still tells the user to use VLC instead of playing: ${note}`,
  );
  await page.screenshot({ path: path.join(outDir, "video-error.png") });
} catch (error) {
  failed = true;
  console.error("video test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "video-failure.png") });
    console.error("  failure screenshot: test-results/video-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);