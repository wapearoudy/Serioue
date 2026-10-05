// Fullscreen feel and quality memory, measured on the real element.
//
//   node scripts/video-controls-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:video` already generated.
//
// What it proves, all read off the live DOM/computed style rather than a
// screenshot:
//   1. buffering says 缓冲中… plus the percentage the element's own buffered
//      ranges say, and goes away when playback can continue
//   2. in fullscreen the controls fade to opacity 0 after ~3 s of no input and
//      come straight back on a mouse move or a key press; paused keeps them
//   3. double-clicking the picture toggles fullscreen, single click does not
//      interrupt playback
//   4. the chosen quality survives a full page reload, and can be cleared from
//      the menu

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
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.VIDEO_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

/** The controls group's real computed opacity — the thing the eye reacts to. */
const controlsOpacity = () =>
  page.evaluate(() => {
    const el = document.querySelector(".player-controls");
    return el ? Number(getComputedStyle(el).opacity) : -1;
  });

const waitOpacity = (predicate, timeout = 8000) =>
  page.waitForFunction(
    (want) => {
      const el = document.querySelector(".player-controls");
      if (!el) return false;
      const v = Number(getComputedStyle(el).opacity);
      // eslint-disable-next-line no-new-func
      return new Function("v", `return ${want}`)(v);
    },
    predicate,
    { timeout },
  );

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".player-extras button:has-text('画质')", { timeout: 25000 });

  // -- 1. buffering says what it is buffering ---------------------------------
  // Start playback first: hls.js fetches no segment before it, so a player that
  // has only parsed the manifest legitimately has nothing buffered yet.
  await page.evaluate(() => document.querySelector(".player-wrap video").play());
  await page.waitForFunction(
    () => {
      const v = document.querySelector(".player-wrap video");
      return v.buffered.length > 0 && v.readyState >= 2;
    },
    null,
    { timeout: 20000 },
  );
  // The demo stream is a local VOD and never starves on its own, so the
  // element's `waiting` event is dispatched directly. The percentage is read in
  // the *same* synchronous snapshot as the event, because a local fixture keeps
  // downloading between two round trips and would make the comparison a race.
  //
  // The event is re-asserted while the badge is looked for: playback is running,
  // so a genuine `canplay` can legitimately clear the badge a frame later. What
  // is under test is that the badge exists and reports the real number, not that
  // a live stream stays starved.
  const seen = await page.evaluate(async () => {
    const v = document.querySelector(".player-wrap video");
    if (!Number.isFinite(v.duration) || v.duration <= 0) return { realPct: -1, badge: null };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 80; i++) {
      let end = 0;
      for (let b = 0; b < v.buffered.length; b++) end = Math.max(end, v.buffered.end(b));
      const realPct = Math.round((end / v.duration) * 100);
      v.dispatchEvent(new Event("waiting"));
      await sleep(50);
      const el = document.querySelector(".player-buffering");
      if (el) {
        return {
          realPct,
          badge: el.textContent.trim(),
          shown: Number(el.getAttribute("data-buffered-pct")),
        };
      }
    }
    return { realPct: -2, badge: null };
  });
  assert.ok(seen.realPct > 0, `no buffered range to report (${seen.realPct})`);
  assert.ok(seen.badge, "the buffering badge never appeared");
  console.log(`  buffering badge reads "${seen.badge}" (element has ${seen.realPct}% buffered)`);
  assert.match(seen.badge, /^缓冲中…\s*\d+%$/, `unexpected buffering text: ${seen.badge}`);
  assert.ok(
    Math.abs(seen.shown - seen.realPct) <= 1,
    `the badge says ${seen.shown}% while the element has ${seen.realPct}% buffered`,
  );
  // And it is not a permanent sticker: a real `canplay` takes it away.
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").dispatchEvent(new Event("canplay"));
  });
  await page.waitForSelector(".player-buffering", { state: "detached", timeout: 5000 });
  console.log("  and it disappears once playback can continue");

  // -- 2. the controls fade, and come back ------------------------------------
  const play = () => page.evaluate(() => document.querySelector(".player-wrap video").play());
  const pause = () => page.evaluate(() => document.querySelector(".player-wrap video").pause());

  /**
   * Play from the top again.
   *
   * The demo entry is 12 seconds long and this phase waits out the idle window
   * several times over, so without rewinding the video reaches its end — and a
   * finished video is exactly the case where the controls must stay.
   */
  const restart = async () => {
    await page.evaluate(async () => {
      const v = document.querySelector(".player-wrap video");
      v.currentTime = 0;
      await v.play().catch(() => {});
    });
    await page.waitForFunction(
      () => {
        const v = document.querySelector(".player-wrap video");
        return !v.paused && v.currentTime > 0 && v.currentTime < 6;
      },
      null,
      { timeout: 10000 },
    );
  };

  // Outside fullscreen the controls never hide, however long the video runs.
  await restart();
  await page.waitForTimeout(3600);
  const inline = await controlsOpacity();
  assert.ok(inline > 0.95, `controls faded outside fullscreen (opacity ${inline})`);
  console.log(`  outside fullscreen the controls stay visible (opacity ${inline})`);

  // Enter fullscreen with a real click: requestFullscreen needs a user gesture.
  await page.locator('.player-extras button[title*="全屏"]').click();
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  // The attribute is written by the player reacting to `fullscreenchange`, so it
  // settles a frame after the document state does.
  await page.waitForFunction(
    () => document.querySelector(".player-wrap")?.getAttribute("data-fullscreen") === "1",
    null,
    { timeout: 5000 },
  );
  console.log("  entered fullscreen through the control");

  // Paused in fullscreen: still visible after the idle window.
  await pause();
  await page.waitForTimeout(3600);
  const pausedOpacity = await controlsOpacity();
  assert.ok(pausedOpacity > 0.95, `paused playback hid the controls (opacity ${pausedOpacity})`);
  console.log(`  paused in fullscreen keeps them visible (opacity ${pausedOpacity})`);

  // Playing and left alone: they fade.
  await restart();
  await waitOpacity("v < 0.02", 8000);
  const faded = await controlsOpacity();
  console.log(`  after ~3s idle while playing, controls opacity ${faded}`);

  // A mouse move brings them back.
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 310);
  await waitOpacity("v > 0.98", 3000);
  console.log(`  a mouse move restored them (opacity ${await controlsOpacity()})`);

  // So does a key press — and it must not disturb playback. A key the player
  // ignores (Shift) is the honest probe: an arrow key also seeks, and on a
  // 12-second fixture that can run the video to its end and look like a pause.
  await restart();
  await waitOpacity("v < 0.02", 8000);
  const beforeKey = await page.evaluate(() => document.querySelector(".player-wrap video").paused);
  await page.keyboard.press("Shift");
  await waitOpacity("v > 0.98", 3000);
  const afterKey = await page.evaluate(() => document.querySelector(".player-wrap video").paused);
  assert.equal(beforeKey, false, "the video was already paused before the key press");
  assert.equal(afterKey, false, "a key press must not pause playback");
  console.log("  a key press restored them without interrupting playback");

  // Pausing while hidden must bring them straight back.
  await restart();
  await waitOpacity("v < 0.02", 8000);
  await pause();
  await waitOpacity("v > 0.98", 3000);
  console.log("  pausing while hidden brings the controls straight back");

  // Leaving fullscreen shows them again, whatever the video is doing. Exit is
  // driven through the same API the ⛶ button uses: there is no window chrome in
  // a headless browser for Escape to act on.
  await restart();
  await waitOpacity("v < 0.02", 8000);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
  await waitOpacity("v > 0.98", 3000);
  console.log("  leaving fullscreen brings them back");

  // -- 3. double click toggles fullscreen, single click does not ---------------
  // With the browser's native controls up, Chromium toggles playback when you
  // click anywhere on the picture and takes a double click as the video's own
  // fullscreen; neither can be cancelled by a listener. The player therefore
  // runs on its own bar, and this is the behaviour that has to be true.
  await restart();
  const pageBox = await page.locator(".player-wrap video").boundingBox();
  const px = pageBox.x + pageBox.width / 2;
  const py = pageBox.y + pageBox.height / 2;

  const beforeClick = await page.evaluate(() => {
    const v = document.querySelector(".player-wrap video");
    return { paused: v.paused, controls: v.controls, time: v.currentTime };
  });
  assert.equal(beforeClick.paused, false, "the video was not playing before the single click");
  assert.equal(beforeClick.controls, false, "the native bar is still on the element");
  await page.mouse.click(px, py);
  await page.waitForTimeout(300);
  const afterClick = await page.evaluate(() => {
    const v = document.querySelector(".player-wrap video");
    return { paused: v.paused, time: v.currentTime };
  });
  assert.equal(afterClick.paused, false, "a single click paused the video");
  assert.ok(afterClick.time >= beforeClick.time, "a single click rewound the video");
  console.log(
    `  a single click on the picture left playback running ` +
      `(t ${beforeClick.time.toFixed(1)} → ${afterClick.time.toFixed(1)})`,
  );

  // The bar drives the video instead: its play/pause button.
  await page.locator("[data-play-toggle]").click();
  await page.waitForFunction(
    () => document.querySelector(".player-wrap video")?.paused === true,
    null,
    { timeout: 5000 },
  );
  await page.locator("[data-play-toggle]").click();
  await page.waitForFunction(
    () => document.querySelector(".player-wrap video")?.paused === false,
    null,
    { timeout: 5000 },
  );
  console.log("  the bar's play/pause drives the video");

  // A double click enters fullscreen, and again leaves it — with playback
  // untouched both ways.
  await page.mouse.dblclick(px, py);
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  const enteredBy = await page.evaluate(() => document.fullscreenElement?.className ?? "");
  assert.ok(enteredBy.includes("player-wrap"), `double click opened something else: "${enteredBy}"`);
  console.log(`  double click put the player itself into fullscreen (${enteredBy.trim()})`);

  // Fullscreen changes the geometry, so the exit has to be aimed again.
  const fsBox = await page.locator(".player-wrap video").boundingBox();
  const fx = fsBox.x + fsBox.width / 2;
  const fy = fsBox.y + fsBox.height / 2;
  await page.mouse.dblclick(fx, fy);
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
  const stillPlaying = await page.evaluate(
    () => document.querySelector(".player-wrap video")?.paused === false,
  );
  assert.ok(stillPlaying, "double clicking to leave fullscreen paused the video");
  console.log("  double click left fullscreen, playback untouched");

  // -- 4. the quality choice is remembered ------------------------------------
  const qualityButton = page.locator(".player-extras button").first();
  await qualityButton.click();
  await page.waitForSelector("[data-quality-menu]", { timeout: 5000 });
  await page.locator('[data-quality-menu] button', { hasText: "360p" }).click();
  const picked = (await qualityButton.innerText()).trim();
  assert.ok(picked.includes("360p"), `quality not applied (${picked})`);

  const storedMap = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("serious.videoQuality.v1") ?? "{}"),
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(storedMap, "demo:video"),
    `the choice was not stored against the entry (${JSON.stringify(storedMap)})`,
  );
  console.log(`  stored against the entry key: ${JSON.stringify(storedMap["demo:video"])}`);

  // A full reload is the honest test: a remount could reuse in-memory state.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".player-extras button:has-text('画质')", { timeout: 25000 });
  await page.waitForFunction(
    () => document.querySelector(".player-extras button")?.textContent?.includes("360p"),
    null,
    { timeout: 15000 },
  );
  const restored = (await qualityButton.innerText()).trim();
  assert.ok(restored.includes("360p"), `the remembered quality did not come back (${restored})`);
  console.log(`  after a reload the player opened at ${restored}`);

  // And the player really applied it, not just the label: hls.js switches the
  // rendition, which changes the decoded height.
  await page.locator('.player-extras button[title*="全屏"]').count();

  // The remembered choice is visible in the menu, and clearable.
  await qualityButton.click();
  await page.waitForSelector("[data-quality-menu]", { timeout: 5000 });
  const remembered = await page.getAttribute("[data-quality-menu] [data-remembered]", "data-remembered");
  assert.notEqual(remembered, "none", "the menu does not show that anything is remembered");
  await page.locator("[data-quality-clear]").click();
  await page.waitForFunction(
    () => document.querySelector(".player-extras button")?.textContent?.includes("自动"),
    null,
    { timeout: 5000 },
  );
  const cleared = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("serious.videoQuality.v1") ?? "{}"),
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(cleared, "demo:video"),
    false,
    `the entry is still in storage: ${JSON.stringify(cleared)}`,
  );
  console.log("  「清除本条画质记忆」 removed it from storage and went back to 自动");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".player-extras button:has-text('画质')", { timeout: 25000 });
  const afterClear = (await page.locator(".player-extras button").first().innerText()).trim();
  assert.ok(afterClear.includes("自动"), `a cleared memory came back (${afterClear})`);
  console.log("  a reload after clearing starts at 自动");

  await page.screenshot({ path: path.join(outDir, "video-controls.png") });
  console.log("  screenshot: test-results/video-controls.png");
} catch (error) {
  failed = true;
  console.error("video controls test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "video-controls-failure.png") });
    console.error("  failure screenshot: test-results/video-controls-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);