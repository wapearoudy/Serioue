// Lyric calibration and queue management, measured rather than eyeballed.
//
//   node scripts/music-queue-lyrics-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:audio` already generated.
//
// Every claim below is backed by a value read back out of the page: the actual
// localStorage contents, the actual DOM text, the actual highlighted lyric
// line. Nothing here asserts that a button exists.
//
//   - the offset shows both a number and a direction, moves the highlighted
//     lyric line at once, is written to localStorage, and survives a reload
//   - 「保存为该源默认」 is inherited by a song that has no offset of its own
//   - 「重置」 goes back to that inherited default
//   - removing a queue item takes it out of the DOM and renumbers the rest
//   - 「插播」 moves an item to immediately after the current one
//   - clearing shows the empty-queue message and stops playback
//   - an unknown length shows `—`, never `NaN`

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";
const OFFSET_STORE = "serious.lyricOffset.v1";
const QUEUE_STORE = "serious.musicQueue.v1";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.MUSIC_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
let failed = false;

const offsets = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}"), OFFSET_STORE);
const queueStore = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}"), QUEUE_STORE);

/** Start from a clean slate: no stored queue, no stored offsets. */
const resetStorage = () =>
  page.evaluate(
    ([o, q]) => {
      localStorage.removeItem(o);
      localStorage.removeItem(q);
    },
    [OFFSET_STORE, QUEUE_STORE],
  );

/** Park the playhead at a known time so the highlighted line is deterministic. */
const seekTo = (t) =>
  page.evaluate((time) => {
    const el = document.querySelector(".music audio");
    el.pause();
    el.currentTime = time;
  }, t);

const currentLyric = () =>
  page.evaluate(() => document.querySelector(".music-lyrics button.now")?.textContent?.trim() ?? "");

/**
 * Open the calibration panel.
 *
 * Idempotent on purpose: the panel survives a track change, so a blind click
 * would close it again and the next assertion would wait for something the test
 * itself had just hidden.
 */
const openCalibration = async () => {
  if ((await page.locator("[data-offset-panel]").count()) === 0) {
    await page.locator("[data-offset-toggle]").click();
  }
  await page.waitForSelector("[data-offset-panel]", { timeout: 5000 });
};

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".music", { timeout: 15000 });
  await page.waitForSelector(".music-lyrics", { timeout: 15000 });
  await resetStorage();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music-lyrics", { timeout: 15000 });

  // -- 1. the offset is visible, and says which way it moves --------------------
  await openCalibration();
  const readout0 = (await page.locator("[data-offset-readout]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  offset readout at rest: "${readout0}"`);
  assert.match(readout0, /0 ms/, `the offset is not shown as a number: ${readout0}`);
  assert.match(readout0, /未校准/, `the offset does not say it is uncalibrated: ${readout0}`);

  // Park at 4.40s: the fixture's lines are 0.4s apart, so this is line 12.
  await seekTo(4.4);
  await page.waitForFunction(
    () => document.querySelector(".music-lyrics button.now")?.textContent?.includes("第 12 行"),
    null,
    { timeout: 10000 },
  );
  const lineAtZero = await currentLyric();
  console.log(`  with no offset, t=4.40s highlights "${lineAtZero}"`);

  // -- 2. moving the offset moves the highlight immediately ---------------------
  // +500 ms means "the lyric should come 500 ms earlier", i.e. at 4.40s of
  // audio the line that belongs to 3.90s is current — line 10, two lines back.
  await page.locator('[data-offset-step="50"]').click({ clickCount: 10 });
  const msAfterTenSteps = await page.locator("[data-offset-ms]").innerText();
  assert.equal(msAfterTenSteps.trim(), "500 ms", `ten 50ms steps should read 500 ms, got ${msAfterTenSteps}`);
  const readout1 = (await page.locator("[data-offset-readout]").innerText()).replace(/\s+/g, " ").trim();
  assert.match(readout1, /歌词提前 500 ms/, `the direction is not explained: ${readout1}`);
  console.log(`  after ten +50ms steps: "${readout1}"`);
  await page.waitForFunction(
    () => document.querySelector(".music-lyrics button.now")?.textContent?.includes("第 10 行"),
    null,
    { timeout: 5000 },
  );
  const lineAfter = await currentLyric();
  console.log(`  at the same t=4.40s the highlight is now "${lineAfter}"`);
  assert.notEqual(lineAfter, lineAtZero, "the highlight did not follow the offset");

  // -- 3. it is written to storage, per song -------------------------------------
  const stored = await offsets();
  const songKey = Object.keys(stored).find((k) => k.includes("track-1.lrc"));
  assert.ok(songKey, `the offset was not filed against the song: ${JSON.stringify(stored)}`);
  assert.equal(stored[songKey], 500, `stored offset is ${stored[songKey]}, expected 500`);
  assert.ok(
    !Object.keys(stored).some((k) => k.includes("track-2.lrc")),
    `a song that was never calibrated got an offset: ${JSON.stringify(stored)}`,
  );
  console.log(`  localStorage ${OFFSET_STORE} = ${JSON.stringify(stored)}`);

  // Fine steps exist and are 10ms.
  await page.locator('[data-offset-fine="-1"]').click();
  const fine = await page.locator("[data-offset-ms]").innerText();
  assert.equal(fine.trim(), "490 ms", `a −10ms step should read 490 ms, got ${fine}`);
  await page.locator('[data-offset-fine="1"]').click();

  // -- 4. it survives a full reload ----------------------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music-lyrics", { timeout: 15000 });
  await openCalibration();
  const sliderValue = await page.locator("[data-offset-slider]").inputValue();
  const afterReload = (await page.locator("[data-offset-ms]").innerText()).trim();
  assert.equal(sliderValue, "500", `the slider came back at ${sliderValue}, expected 500`);
  assert.equal(afterReload, "500 ms", `the readout came back as ${afterReload}`);
  console.log(`  after a reload the calibration is still there: slider=${sliderValue}, readout="${afterReload}"`);

  // -- 5. a source default reaches a song that has none --------------------------
  await page.locator("[data-offset-save-source]").click();
  const afterSourceSave = await offsets();
  assert.equal(
    afterSourceSave["source:demo:album"],
    500,
    `the source default was not saved: ${JSON.stringify(afterSourceSave)}`,
  );
  console.log(`  source default saved: ${JSON.stringify(afterSourceSave)}`);

  await page.locator(".music-queue li").nth(1).click();
  await page.waitForFunction(
    () => document.querySelector(".music-queue li.playing .t")?.textContent?.includes("第二首"),
    null,
    { timeout: 10000 },
  );
  await openCalibration();
  // Wait for the per-song calibration effect to run: reading the readout the
  // instant after the row click would still show the previous song's state.
  await page.waitForFunction(
    () => /本曲尚未保存/.test(document.querySelector("[data-offset-readout]")?.textContent ?? ""),
    null,
    { timeout: 5000 },
  );
  const inherited = (await page.locator("[data-offset-readout]").innerText()).replace(/\s+/g, " ").trim();
  assert.match(inherited, /500 ms/, `the second song did not inherit the source default: ${inherited}`);
  assert.match(inherited, /本曲尚未保存/, `it should be inherited, not saved for this song: ${inherited}`);
  console.log(`  the second song inherits it: "${inherited}"`);

  // -- 6. reset falls back to that inherited default -----------------------------
  await page.locator('[data-offset-fine="1"]').click();
  assert.equal((await page.locator("[data-offset-ms]").innerText()).trim(), "510 ms");
  await page.locator("[data-offset-reset]").click();
  const afterReset = (await page.locator("[data-offset-ms]").innerText()).trim();
  assert.equal(afterReset, "500 ms", `reset should fall back to the source default, got ${afterReset}`);
  console.log(`  reset returns to the inherited default: ${afterReset}`);

  // -- 7. the queue: summary, artist and honest lengths --------------------------
  await page.locator(".music-queue li").nth(0).click();
  await page.waitForFunction(
    () => document.querySelector(".music-queue li.playing .t")?.textContent?.includes("第一首"),
    null,
    { timeout: 10000 },
  );
  const summary = (await page.locator("[data-queue-summary]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  queue summary: "${summary}"`);
  assert.match(summary, /播放队列 · 3 首/, `wrong queue summary: ${summary}`);
  assert.match(summary, /第 1\/3 首/, `the current position is missing: ${summary}`);
  // The third track's length is unknown before it has ever been played, so the
  // total says so rather than quietly summing the two that are known.
  assert.match(summary, /总时长 —/, `the total claims a length it does not have: ${summary}`);

  const artists = await page.locator("[data-queue-artist]").allInnerTexts();
  assert.deepEqual(artists.map((t) => t.trim()), ["演示歌手 · 甲", "演示歌手 · 乙", "—"]);
  const lengths = await page.locator("[data-queue-duration]").allInnerTexts();
  assert.deepEqual(lengths.map((t) => t.trim()), ["0:08", "0:02", "—"]);
  assert.ok(!lengths.some((t) => /NaN|undefined/.test(t)), `a length leaked a NaN: ${lengths}`);
  console.log(`  artists: ${JSON.stringify(artists.map((t) => t.trim()))}`);
  console.log(`  lengths: ${JSON.stringify(lengths.map((t) => t.trim()))}`);

  // Play every track once, so the element reports its real length. The fixture
  // files are 8.0 s, 2.0 s and 1.2 s.
  for (const [i, name] of [[1, "第二首"], [2, "第三首"], [0, "第一首"]]) {
    await page.locator(".music-queue li").nth(i).click();
    await page.waitForFunction(
      (want) => document.querySelector(".music-queue li.playing .t")?.textContent?.includes(want),
      name,
      { timeout: 10000 },
    );
  }
  const learned = await page.locator("[data-queue-duration]").allInnerTexts();
  const learnedTotal = (await page.locator("[data-queue-total]").innerText()).trim();
  console.log(`  after playing each track once: lengths ${JSON.stringify(learned.map((t) => t.trim()))}, total ${learnedTotal}`);
  assert.deepEqual(learned.map((t) => t.trim()), ["0:08", "0:02", "0:01"]);
  assert.equal(learnedTotal, "0:11", `the learned total should be 8.0+2.0+1.2s, got ${learnedTotal}`);

  // -- 8. 插播 puts an item immediately after the current one --------------------
  // Current is 第一首 (index 0); move 第三首 (index 2) to play next.
  await page.locator('[data-queue-insert="/demo/track-3.wav"]').click();
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll(".music-queue li")];
      return rows.length === 3 && rows[1]?.getAttribute("data-queue-item")?.includes("track-3.wav");
    },
    null,
    { timeout: 5000 },
  );
  const order = await page.evaluate(() =>
    [...document.querySelectorAll(".music-queue li")].map((li) =>
      li.getAttribute("data-queue-item").split("/").pop(),
    ),
  );
  const currentUrl = await page.evaluate(() =>
    document.querySelector(".music-queue li.playing")?.getAttribute("data-queue-item"),
  );
  console.log(`  order after 插播: ${JSON.stringify(order)} (current ${currentUrl.split("/").pop()})`);
  assert.deepEqual(order, ["track-1.wav", "track-3.wav", "track-2.wav"]);
  assert.ok(currentUrl.endsWith("track-1.wav"), "插播 changed what was playing");

  // And it really plays next.
  await page.locator('[data-queue-next="1"]').click();
  await page.waitForFunction(
    () => document.querySelector(".music-queue li.playing .t")?.textContent?.includes("第三首"),
    null,
    { timeout: 10000 },
  );
  console.log("  「下一首」 lands on the item that was queued to play next");

  const savedQueue = (await queueStore())["demo:album"];
  assert.ok(savedQueue, "the queue was not remembered");
  assert.deepEqual(savedQueue.urls, [
    "/demo/track-1.wav",
    "/demo/track-3.wav",
    "/demo/track-2.wav",
  ]);
  console.log(`  queue persisted: ${JSON.stringify(savedQueue.urls)}`);

  // -- 9. removing an item drops it from the DOM and renumbers the rest ---------
  await page.locator('[data-queue-remove="/demo/track-2.wav"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".music-queue li").length === 2, null, {
    timeout: 5000,
  });
  const afterRemove = await page.evaluate(() =>
    [...document.querySelectorAll(".music-queue li")].map((li) => ({
      url: li.getAttribute("data-queue-item").split("/").pop(),
      n: li.querySelector(".n").textContent.trim(),
      playing: li.classList.contains("playing"),
    })),
  );
  console.log(`  after removing track-2: ${JSON.stringify(afterRemove)}`);
  assert.deepEqual(afterRemove.map((r) => r.url), ["track-1.wav", "track-3.wav"]);
  assert.deepEqual(afterRemove.map((r) => r.n), ["1", "2"], "the numbering did not close up");
  assert.ok(!afterRemove.some((r) => r.url === "track-2.wav"), "the removed item is still in the DOM");
  assert.ok(afterRemove.find((r) => r.playing)?.url === "track-3.wav", "the wrong row is marked playing");

  // -- 10. the removal survives a reload ------------------------------------------
// Wait for the store rather than sleeping: the queue is written from a passive
  // effect, and a reload issued before that effect flushes would test the
  // browser's timing instead of the player.
  await page.waitForFunction(
    (k) => {
      const saved = JSON.parse(localStorage.getItem(k) ?? "{}")["demo:album"];
      return saved && saved.urls.length === 2;
    },
    QUEUE_STORE,
    { timeout: 5000 },
  );
  const removedStore = (await queueStore())["demo:album"];
  console.log(`  localStorage ${QUEUE_STORE} = ${JSON.stringify(removedStore.urls)}`);
  assert.deepEqual(removedStore.urls, ["/demo/track-1.wav", "/demo/track-3.wav"]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
  const afterReloadRows = await page.evaluate(() =>
    [...document.querySelectorAll(".music-queue li")].map((li) =>
      li.getAttribute("data-queue-item").split("/").pop(),
    ),
  );
  assert.deepEqual(afterReloadRows, ["track-1.wav", "track-3.wav"], "the removal did not survive");
  console.log(`  after a reload the queue is still ${JSON.stringify(afterReloadRows)}`);

  // -- 11. clearing states it, and stops playback ---------------------------------
  await page.locator("[data-queue-clear]").click();
  await page.waitForSelector("[data-queue-empty]", { timeout: 5000 });
  const emptyText = (await page.locator("[data-queue-empty]").innerText()).replace(/\s+/g, " ").trim();
  const paused = await page.evaluate(() => document.querySelector(".music audio").paused);
  console.log(`  empty queue says: "${emptyText}" (paused=${paused})`);
  assert.match(emptyText, /播放队列已空/, `the empty queue says nothing useful: ${emptyText}`);
  assert.match(emptyText, /播放已停止/, `the empty queue does not say playback stopped: ${emptyText}`);
  assert.equal(await page.locator(".music-queue li").count(), 0);
  assert.equal(paused, true, "clearing left the audio playing");
  const clearedStore = (await queueStore())["demo:album"];
  assert.equal(clearedStore, undefined, "a cleared queue is still remembered");
  console.log("  clearing stops playback and forgets the queue");

  // And there is a way back.
  await page.locator("[data-queue-restore]").click();
  await page.waitForFunction(() => document.querySelectorAll(".music-queue li").length === 3, null, {
    timeout: 5000,
  });
  console.log("  「恢复全部」 brings the page's list back");

  await page.screenshot({ path: path.join(outDir, "music-queue-lyrics.png"), fullPage: true });
  console.log("  screenshot: test-results/music-queue-lyrics.png");
} catch (error) {
  failed = true;
  console.error("music queue/lyrics test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "music-queue-lyrics-failure.png"), fullPage: true });
    console.error("  failure screenshot: test-results/music-queue-lyrics-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);