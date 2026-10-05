// Sleep timer, measured on the audio element itself.
//
//   node scripts/music-sleep-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:audio` already generated.
//
// What it proves — all of it by reading `audio.volume` and `audio.paused` out of
// a real browser, never the on-screen text (the text is only checked for
// visibility, since an invisible timer is its own failure):
//
//   1. the real 15/30/45/60-minute options and 「本曲结束」 are offered, and the
//      countdown is visible while a timer is armed
//   2. 「本曲结束」 ramps the volume monotonically down to 0 and pauses, without
//      skipping to the next track
//   3. cancelling mid-fade restores the original volume at once and the ramp
//      really stops — a late frame must not drag the volume back down
//   4. a timed option ramps down to 0 and pauses, all the way this time
//
// Short options come from the preview page's `?sleepMinutes=` parameter, because
// a 15-minute wait proves nothing about a 15-second fade.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";
// 0.05 min = 3 s, so the countdown is observable without a long wait. The fade
// behind it is the real 20 seconds — that is the behaviour under test, not
// something to shrink for convenience.
const fast = `${base}?sleepMinutes=0.05`;

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.MUSIC_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
let failed = false;

/** Sample the element's own volume every frame while `body` runs. */
const startSampling = () =>
  page.evaluate(() => {
    const el = document.querySelector(".music audio");
    window.__samples = [];
    window.__sampling = true;
    const loop = () => {
      if (!window.__sampling) return;
      // A pause between ramp frames would look like a plateau; record the value
      // the element actually had at that frame, which is all we assert on.
      window.__samples.push([performance.now(), el.volume, el.paused]);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

const stopSampling = () =>
  page.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
  });

const audio = () =>
  page.evaluate(() => {
    const el = document.querySelector(".music audio");
    return { volume: el.volume, paused: el.paused, time: el.currentTime, muted: el.muted };
  });

/**
 * Record when the cancel button was clicked, in the page's own clock, so the
 * samples can be split at the exact interruption instead of at a guess.
 */
const markClicks = () =>
  page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target instanceof Element ? e.target.closest("[data-sleep-action]") : null;
        window.__clicks.push([performance.now(), el?.getAttribute("data-sleep-action") ?? ""]);
      },
      true,
    );
  });

const clickTime = (action) =>
  page.evaluate((a) => {
    const hits = (window.__clicks || []).filter((c) => c[1] === a);
    return hits.length ? hits[hits.length - 1][0] : -1;
  }, action);

/** True if `samples` never goes up while the ramp is running. */
function assertMonotonicDown(samples, label) {
  assert.ok(samples.length > 5, `${label}: only ${samples.length} frames sampled`);
  let increases = 0;
  let drops = 0;
  let previous = samples[0][1];
  for (const [, value] of samples) {
    if (value > previous + 1e-9) increases += 1;
    if (value < previous - 1e-6) drops += 1;
    previous = value;
  }
  assert.equal(increases, 0, `${label}: volume went up ${increases} time(s) during the fade`);
  assert.ok(drops >= 5, `${label}: volume only ever decreased ${drops} time(s), so no real ramp ran`);
}

try {
  // -- 1. the options, and a countdown you can see ----------------------------
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".music", { timeout: 15000 });

  const toggle = page.locator("[data-sleep-toggle]");
  await toggle.click();
  const options = await page.locator("[data-sleep-option]").allInnerTexts();
  assert.deepEqual(
    options.map((t) => t.trim()),
    ["15 分钟", "30 分钟", "45 分钟", "60 分钟", "本曲结束"],
    `unexpected sleep options: ${JSON.stringify(options)}`,
  );
  console.log(`  options offered: ${options.join(" / ")}`);

  await page.locator('[data-sleep-option="15"]').click();
  const armed = (await toggle.innerText()).trim();
  assert.match(armed, /剩余 1[45]:\d\d/, `the countdown is not visible on the button: ${armed}`);
  const status = (await page.locator("[data-sleep-status]").innerText()).trim();
  assert.match(status, /睡眠定时已开启/, `the status line does not show the timer: ${status}`);
  console.log(`  15-minute timer armed and visible: "${armed}" / "${status}"`);

  await toggle.click();
  await page.locator('[data-sleep-action="cancel"]').click();
  assert.equal(await page.locator("[data-sleep-status]").count(), 0, "cancelling left a status behind");
  assert.ok(!(await toggle.innerText()).includes("剩余"), "cancelling left the countdown on screen");
  console.log("  cancelling clears both the countdown and the status");

  // -- 2. 「本曲结束」 fades out and pauses ------------------------------------
  await page.goto(fast, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".music", { timeout: 15000 });
  await markClicks();
  await page.locator(".music-volume").fill("0.8");
  // A 2-second fixture, so the ramp has to start immediately: `本曲结束` on a
  // track shorter than the fade window is the honest edge case.
  await page.locator(".music-queue li").nth(1).click();
  await page.locator("[data-sleep-toggle]").click();
  await page.locator('[data-sleep-option="track-end"]').click();
  assert.ok(
    (await toggle.innerText()).includes("本曲结束"),
    "the track-end timer is not visible on the button",
  );
  await startSampling();
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".music audio");
      return el.paused && el.volume === 0 && el.currentTime > 0.3;
    },
    null,
    { timeout: 20000 },
  );
  let samples = await stopSampling();
  const beforeFade = samples.filter(([, , paused]) => !paused);
  assertMonotonicDown(beforeFade, "track-end fade");
  assert.equal(samples[samples.length - 1][1], 0, "the track-end ramp did not reach 0");
  const stillSecond = await page.locator(".music-queue li.playing .t").innerText();
  assert.ok(stillSecond.includes("第二首"), `the timer skipped ahead: now on ${stillSecond}`);
  const afterTrackEnd = (await toggle.innerText()).trim();
  assert.ok(!afterTrackEnd.includes("本曲结束"), `the timer is still armed: ${afterTrackEnd}`);
  console.log(
    `  track-end fade: ${samples.length} frames, volume ${samples[0][1].toFixed(3)} → ` +
      `${samples[samples.length - 1][1].toFixed(3)}, paused on ${stillSecond.trim()}, timer cleared`,
  );

  // -- 2b. 「本曲结束」 names one track, so changing track retires it -----------
  await page.locator(".music-queue li").nth(0).click();
  await page.locator("[data-sleep-toggle]").click();
  await page.locator('[data-sleep-option="track-end"]').click();
  assert.ok((await toggle.innerText()).includes("本曲结束"), "the track-end timer did not arm");
  await page.locator(".music-queue li").nth(2).click();
  await page.waitForFunction(
    () => !document.querySelector("[data-sleep-toggle]").textContent.includes("本曲结束"),
    null,
    { timeout: 5000 },
  );
  assert.equal(
    await page.locator("[data-sleep-status]").count(),
    0,
    "a track change left the timer state on screen",
  );
  console.log("  switching tracks retires the track-end timer");

  // -- 3. cancelling mid-fade --------------------------------------------------
  // Loop the 8 s fixture so a 6 s countdown plus a 6 s fade is not cut short by
  // the track ending underneath it.
  await page.evaluate(() => {
    document.querySelector(".music audio").loop = true;
  });
  await page.locator(".music-volume").fill("0.8");
  await page.locator(".music-queue li").nth(0).click();
  await page.locator("[data-sleep-toggle]").click();
  await page.locator('[data-sleep-option="0.05"]').click();
  await startSampling();
  // Wait for the ramp to be under way before interrupting it.
  await page.waitForFunction(() => document.querySelector(".music audio").volume < 0.72, null, {
    timeout: 25000,
  });
  await page.locator("[data-sleep-toggle]").click();
  await page.locator('[data-sleep-action="cancel"]').click();
  await page.waitForTimeout(1000);
  samples = await stopSampling();
  const restored = await audio();
  assert.ok(
    Math.abs(restored.volume - 0.8) < 0.02,
    `cancelling did not restore the volume (${restored.volume})`,
  );
  assert.equal(restored.paused, false, "cancelling paused playback; it should only stop the fade");
  // The frames after the cancel click must be flat: a ramp that keeps running
  // past the interruption is exactly the bug this is here to catch.
  const cancelAt = await clickTime("cancel");
  assert.ok(cancelAt > 0, "the cancel click was never seen");
  const tail = samples.filter(([t]) => t >= cancelAt).map(([, v]) => v);
  assert.ok(tail.length > 20, `only ${tail.length} frames sampled after the cancel`);
  const tailMax = Math.max(...tail);
  const tailMin = Math.min(...tail);
  assert.ok(
    tailMax - tailMin < 0.02,
    `the ramp kept running after the cancel (${tailMin.toFixed(3)} → ${tailMax.toFixed(3)})`,
  );
  console.log(
    `  cancel mid-fade: volume restored to ${restored.volume.toFixed(3)}, still playing, ` +
      `ramp flat for the following ${tail.length} frames`,
  );

  // -- 4. a timed option all the way to zero and a pause ------------------------
  await page.locator(".music-volume").fill("0.8");
  await page.locator("[data-sleep-toggle]").click();
  await page.locator('[data-sleep-option="0.05"]').click();
  await startSampling();
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".music audio");
      return el.paused && el.volume === 0;
    },
    null,
    { timeout: 45000 },
  );
  samples = await stopSampling();
  const ramp = samples.filter(([, , paused]) => !paused);
  assertMonotonicDown(ramp, "timed fade");
  assert.equal(samples[samples.length - 1][1], 0, "the timed ramp did not reach 0");
  // Countdown, then the documented 20-second ramp: measure the ramp itself, so
  // the assertion is about the fade and not about the countdown length.
  const rampStart = samples.findIndex(([, v]) => v < 0.795);
  assert.ok(rampStart > 0, "the fade never started");
  const rampSeconds = (samples[samples.length - 1][0] - samples[rampStart][0]) / 1000;
  assert.ok(
    rampSeconds > 17 && rampSeconds < 24,
    `the fade took ${rampSeconds.toFixed(1)}s, expected the documented ~20s`,
  );
  const total = (samples[samples.length - 1][0] - samples[0][0]) / 1000;
  const playGlyph = (await page.locator(".music-play").innerText()).trim();
  assert.equal(playGlyph, "▶", `the player should look paused after the timer, saw ${playGlyph}`);
  console.log(
    `  timed fade: ${total.toFixed(1)}s from arming to silence ` +
      `(${rampSeconds.toFixed(1)}s of it the ramp), volume fell monotonically to 0, playback stopped`,
  );

  await page.screenshot({ path: path.join(outDir, "music-sleep.png") });
  console.log("  screenshot: test-results/music-sleep.png");
} catch (error) {
  failed = true;
  console.error("music sleep test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "music-sleep-failure.png") });
    console.error("  failure screenshot: test-results/music-sleep-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);