// Volume memory, resume points and "which song was playing" — measured through
// the real stores and the real element.
//
//   node scripts/music-memory-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:audio` already generated.
//
// Nothing here asserts that a label appeared. The claims are about
// `localStorage`'s actual contents and about what the `<audio>` element does:
// where it starts, what volume it gets, and what a reopened player remembers.
//
// The resume section serves its own 30-second WAV from a temporary HTTP server,
// because the shared demo fixtures are 1–8 seconds long and a ten-second resume
// threshold cannot be crossed on an eight-second file. Lengthening the shared
// fixtures is not an option: the lyric and queue legs assert against them.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";
const VOLUME_STORE = "serious.musicVolume.v1";
const RESUME_STORE = "serious.musicResume.v1";
const LAST_STORE = "serious.musicLastPlayed.v1";
const QUEUE_STORE = "serious.musicQueue.v1";
const OFFSET_STORE = "serious.lyricOffset.v1";

/** 8-bit unsigned mono PCM at 8 kHz, the same shape the demo fixtures use. */
function tone({ seconds, hz = 440, rate = 8000 }) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const edge = Math.min(1, i / 200, (samples - i) / 200);
    data[i] = Math.round(128 + 90 * edge * Math.sin((2 * Math.PI * hz * i) / rate));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Long enough that the track cannot *finish* while the test is still using it.
// At 30s it could: the legs play to 5s and then to 20s, and with the reloads in
// between the wall clock sometimes ran past the end. The player then auto-advanced
// to the next queue entry and recorded that one as 「上次在听」, so the next reload
// came back on a two-second demo track and the resume leg failed with a timeout
// that said nothing about any of this. Five minutes costs a few hundred kilobytes.
const LONG_SECONDS = 300;
const wav = tone({ seconds: LONG_SECONDS, hz: 330 });

/** A one-file server, with the range support a `<audio>` element expects. */
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Number(match[2]) : wav.length - 1;
    res.writeHead(206, {
      "Content-Type": "audio/wav",
      "Content-Range": `bytes ${start}-${end}/${wav.length}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    res.end(wav.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
  res.end(wav);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const longUrl = `http://127.0.0.1:${port}/long.wav`;
console.log(`  serving a ${LONG_SECONDS}s test tone at ${longUrl}`);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.MUSIC_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
let failed = false;

const store = (k) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), k);
const element = () =>
  page.evaluate(() => {
    const el = document.querySelector(".music audio");
    return { volume: el.volume, muted: el.muted, currentTime: el.currentTime, paused: el.paused };
  });

/**
 * Everything the "which song was playing" question turns on, in one read.
 *
 * The obvious assertion here is a trap: click a row, wait for `currentTime > 0`,
 * read the store. The *previous* song may already have been past that mark, so
 * the wait is satisfied before the song that was clicked has produced a single
 * sample — and the test then asserts about the wrong track. Every wait below is
 * tied to the track it means.
 */
const listening = () =>
  page.evaluate(() => {
    const el = document.querySelector(".music audio");
    const row = document.querySelector(".music-queue li.playing");
    return {
      trackUrl: (row?.getAttribute("data-queue-item") ?? "").split("/").pop(),
      // The component's own belief about playback, published as data-playing —
      // read rather than inferred from the play button's glyph.
      playing: document.querySelector(".music")?.getAttribute("data-playing"),
      audioSrc: (el.getAttribute("src") || el.currentSrc || "").split("/").pop(),
      paused: el.paused,
      currentTime: Number(el.currentTime.toFixed(3)),
      lastPlayed: JSON.parse(localStorage.getItem("serious.musicLastPlayed.v1") ?? "{}")["demo:album"],
    };
  });

/**
 * Play from `seconds` onwards and wait until playback is genuinely past it.
 *
 * The readiness wait matters: seeking an element whose duration is still unknown
 * silently does nothing, and the test would then be watching a song from 0 while
 * believing it was testing a position.
 */
const playFrom = async (seconds) => {
  // A bare timeout here used to say nothing, so it is worth being explicit about
  // what the element was actually doing: which track it had, whether the network
  // state was stalled or errored, and how long it thought the track was. Those
  // are four different bugs behind one message.
  await page.waitForFunction(
    (want) => {
      const el = document.querySelector(".music audio");
      if (!el) return false;
      // The long track specifically, not merely "some track": the resume legs are
      // about *this* song, and silently waiting on whichever one happened to load
      // turns a wrong-track failure into a bare timeout.
      return (el.currentSrc || el.src) === want && el.readyState >= 1 && el.duration > 25;
    },
    longUrl,
    { timeout: 25000 },
  ).catch(async () => {
    const detail = await page
      .evaluate(() => {
        const el = document.querySelector(".music audio");
        if (!el) return { error: "no <audio> element" };
        return {
          src: el.currentSrc || el.src || null,
          readyState: el.readyState,
          networkState: el.networkState,
          duration: Number.isFinite(el.duration) ? Number(el.duration.toFixed(2)) : String(el.duration),
          currentTime: Number(el.currentTime.toFixed(2)),
          error: el.error ? `${el.error.code}: ${el.error.message}` : null,
          seeking: el.seeking,
          paused: el.paused,
        };
      })
      .catch((e) => ({ error: String(e).split("\n")[0] }));
    throw new Error(
      `the long track never became playable (expected ${longUrl}): ${JSON.stringify(detail)}`,
    );
  });
  await page.evaluate(async (t) => {
    const el = document.querySelector(".music audio");
    el.currentTime = t;
    await el.play();
  }, seconds);
  await page.waitForFunction(
    (t) => document.querySelector(".music audio").currentTime > t + 0.3,
    seconds,
    { timeout: 20000 },
  );
};

const STORES = [VOLUME_STORE, RESUME_STORE, LAST_STORE, QUEUE_STORE, OFFSET_STORE];

// Clearing the stores while the player is still mounted does not stick: it writes
// its queue arrangement on every change, so a metadata event landing after the
// reset puts the old arrangement straight back. That made the next reload come up
// on a queue restored from the *previous* leg — with the previous leg's tracks
// matched by URL against the new list, so the long test track dropped out and
// playback silently started on a two-second demo track instead.
//
// `?wipe=1` therefore clears the stores in an init script, which runs before any
// of the app's own code does. The subsequent reload deliberately omits the
// parameter, so the stores are empty going into it rather than being emptied
// while the previous page is still alive.
await page.addInitScript((keys) => {
  if (!new URLSearchParams(window.location.search).has("wipe")) return;
  for (const key of keys) localStorage.removeItem(key);
}, STORES);

try {
  // -- 1. volume is remembered per source ---------------------------------------
  // Wipe, then load again without the flag: `reload()` keeps the query string, so
  // a page still carrying `wipe=1` would empty the stores again on every later
  // reload and nothing would ever be remembered.
  await page.goto(`${url}?wipe=1`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".music", { timeout: 15000 });

  await page.locator(".music-volume").fill("0.3");
  await page.waitForTimeout(150);
  let stored = await store(VOLUME_STORE);
  console.log(`  after setting 30%: ${VOLUME_STORE} = ${JSON.stringify(stored["demo:album"])}`);
  assert.equal(stored["demo:album"]?.volume, 0.3, "the volume was not stored under the source key");

  // Muting is part of "how loud", and a listener who muted for a call wants it
  // still muted next time.
  await page.locator('.music-controls button[title="静音"]').click();
  await page.waitForTimeout(150);
  stored = await store(VOLUME_STORE);
  console.log(`  after muting: ${JSON.stringify(stored["demo:album"])}`);
  assert.equal(stored["demo:album"]?.muted, true, "the mute state was not stored");

  // A reload is the honest test of "remembered": in-memory state would survive
  // a remount without any storage at all.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music", { timeout: 15000 });
  await page.waitForTimeout(300);
  let afterReload = await element();
  let slider = await page.locator(".music-volume").inputValue();
  const muteGlyph = (await page.locator('.music-controls button[title="取消静音"]').count()) === 1;
  console.log(
    `  after a reload: element volume=${afterReload.volume}, slider=${slider}, muted=${afterReload.muted} (button offers unmute=${muteGlyph})`,
  );
  assert.ok(Math.abs(afterReload.volume - 0.3) < 0.01, `the element came back at ${afterReload.volume}`);
  assert.equal(afterReload.muted, true, "the element came back unmuted");
  assert.equal(slider, "0.3", "the slider lost the chosen level while muted");
  assert.ok(muteGlyph, "the mute button does not offer to unmute");

  // Unmuting must not turn into silence: mute is `el.muted`, not volume zero.
  await page.locator('.music-controls button[title="取消静音"]').click();
  await page.waitForTimeout(150);
  stored = await store(VOLUME_STORE);
  const unmuted = await element();
  console.log(
    `  after unmuting: element volume=${unmuted.volume}, muted=${unmuted.muted}, stored ${JSON.stringify(stored["demo:album"])}`,
  );
  assert.equal(stored["demo:album"].muted, false, "unmuting was not stored");
  assert.ok(Math.abs(unmuted.volume - 0.3) < 0.01, `unmuting changed the level to ${unmuted.volume}`);

  // -- 2. a position below the threshold is deliberately not resumed -------------
  // Ten seconds is the floor: below it, "I opened it and closed it again" is a
  // better reading than "I was part-way through and want the rest".
  await page.goto(`${url}?src=${encodeURIComponent(longUrl)}&wipe=1`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector(".music", { timeout: 15000 });
  // A second load, this time without `wipe`, so the reload starts from stores
  // that are genuinely empty rather than emptied underneath a live player.
  await page.goto(`${url}?src=${encodeURIComponent(longUrl)}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector(".music", { timeout: 15000 });

  await playFrom(5);
  await page.evaluate(() => document.querySelector(".music audio").pause());
  await page.waitForTimeout(200);
  stored = await store(RESUME_STORE);
  const shortUrl = Object.keys(stored)[0];
  console.log(`  after ~5s: ${RESUME_STORE} = ${JSON.stringify(stored)}`);
  assert.ok(stored[shortUrl]?.position > 5, `the position was not stored: ${JSON.stringify(stored)}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music", { timeout: 15000 });
  const shortNotice = await page.locator("[data-resume-text]").count();
  await page.locator(".music-play").click();
  await page.waitForFunction(
    () => document.querySelector(".music audio").currentTime > 0.3,
    null,
    { timeout: 10000 },
  );
  const shortStart = (await element()).currentTime;
  console.log(`  reopened after ~5s: ${shortNotice} banner(s), started at ${shortStart.toFixed(2)}s`);
  assert.equal(shortNotice, 0, "a 5-second position should not be offered as a resume");
  assert.ok(shortStart < 4, `it resumed a 5-second position to ${shortStart.toFixed(2)}s`);

  // -- 3. a position past the threshold is resumed, and said out loud --------------
  await playFrom(20);
  await page.evaluate(() => document.querySelector(".music audio").pause());
  await page.waitForTimeout(200);
  stored = await store(RESUME_STORE);
  console.log(`  after ~20s: ${JSON.stringify(stored[shortUrl])}`);
  assert.ok(stored[shortUrl].position > 20, `the later position was not stored: ${JSON.stringify(stored)}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music", { timeout: 15000 });
  const notice = (await page.locator("[data-resume-text]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  on reopening, the banner reads: "${notice}"`);
  assert.match(notice, /已从 0:20 继续/, `no honest notice: ${notice}`);

  await page.locator(".music-play").click();
  await page.waitForFunction(
    () => document.querySelector(".music audio").currentTime > 20.4,
    null,
    { timeout: 10000 },
  );
  const resumed = await element();
  console.log(`  pressing play actually started it at ${resumed.currentTime.toFixed(2)}s`);
  assert.ok(resumed.currentTime > 20, `it restarted from the top (${resumed.currentTime}s)`);

  // 「从头开始」 is the way back, and it must clear the memory rather than
  // leaving it to reappear on the next visit.
  await page.locator("[data-resume-top]").click();
  await page.waitForTimeout(200);
  stored = await store(RESUME_STORE);
  console.log(`  after 从头开始: ${JSON.stringify(stored[shortUrl])}`);
  assert.ok(!stored[shortUrl] || stored[shortUrl].position === 0, "从头开始 did not clear the position");

  // -- 4. a finished song starts over --------------------------------------------
  await page.evaluate(async () => {
    const el = document.querySelector(".music audio");
    el.currentTime = Math.max(0, el.duration - 0.3);
    await el.play();
  });
  await page.waitForFunction(() => document.querySelector(".music audio").ended === true, null, {
    timeout: 20000,
  });
  await page.waitForTimeout(300);
  stored = await store(RESUME_STORE);
  console.log(`  after playing to the end: ${JSON.stringify(stored[shortUrl])}`);
  assert.equal(stored[shortUrl]?.completed, true, "the finished song was not marked done");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music", { timeout: 15000 });
  const afterFinishNotice = await page.locator("[data-resume-text]").count();
  await page.locator(".music-play").click();
  await page.waitForFunction(
    () => document.querySelector(".music audio").currentTime > 0.3,
    null,
    { timeout: 10000 },
  );
  const restarted = (await element()).currentTime;
  console.log(
    `  a finished song reopened with ${afterFinishNotice} banner(s) and started at ${restarted.toFixed(2)}s`,
  );
  assert.ok(
    restarted < 20,
    `a finished song resumed to the end instead of the beginning (${restarted.toFixed(2)}s)`,
  );

  // -- 5. "which song was playing" -------------------------------------------------
  // The 30-second track finished, so the queue moved on by itself: the remembered
  // song must be one that really was heard, not the one the test opened first.
  let last = await store(LAST_STORE);
  const queueUrls = await page.evaluate(() =>
    [...document.querySelectorAll(".music-queue li")].map((li) => li.getAttribute("data-queue-item")),
  );
  console.log(`  ${LAST_STORE} = ${JSON.stringify(last)} (queue: ${JSON.stringify(queueUrls)})`);
  assert.ok(
    queueUrls.includes(last["demo:album"]),
    `the remembered song is not in the queue: ${last["demo:album"]}`,
  );
  assert.notEqual(last["demo:album"], shortUrl, "it still points at the track that finished long ago");

  // Deterministic setup. The step above left the queue auto-advancing, so by now
  // the player may already be on some other song — which is not a state this
  // question can be asked in. Forget both the arrangement and the remembered
  // song, reload, and start from a known place.
  await page.evaluate(
    ([q, l]) => {
      localStorage.removeItem(q);
      localStorage.removeItem(l);
    },
    [QUEUE_STORE, LAST_STORE],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
  const beforeClick = await listening();
  console.log(`  before the click: ${JSON.stringify(beforeClick)}`);
  assert.ok(
    beforeClick.lastPlayed === null || beforeClick.lastPlayed === undefined,
    `the remembered song was not actually cleared: ${beforeClick.lastPlayed}`,
  );

  await page.locator(".music-queue li").nth(1).click();
  // Wait for *this* song, not for a clock the previous song was already past.
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".music audio");
      const row = document.querySelector(".music-queue li.playing");
      return (
        row?.getAttribute("data-queue-item") === "/demo/track-2.wav" &&
        (el.getAttribute("src") || el.currentSrc || "").includes("track-2.wav") &&
        el.currentTime > 0.2
      );
    },
    null,
    { timeout: 15000 },
  );
  const afterClick = await listening();
  console.log(`  after  the click: ${JSON.stringify(afterClick)}`);
  assert.equal(
    afterClick.lastPlayed,
    "/demo/track-2.wav",
    `the last played song did not follow playback (before: ${beforeClick.lastPlayed}, after: ${afterClick.lastPlayed})`,
  );
  assert.equal(afterClick.audioSrc, "track-2.wav", "the element is still on the previous song");
  await page.evaluate(() => document.querySelector(".music audio").pause());
  last = await store(LAST_STORE);
  console.log(`  after playing track-2: ${JSON.stringify(last)}`);
  assert.equal(last["demo:album"], "/demo/track-2.wav", "the last played song did not follow playback");

  // Forget the queue arrangement (not the memory under test) so the reopened page
  // starts on the first track: then the remembered song and the current one are
  // different, which is the situation 「继续上次」 exists for.
  await page.evaluate((k) => localStorage.removeItem(k), QUEUE_STORE);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
  const marker = (await page.locator("[data-last-played]").innerText()).trim();
  const markerUrl = await page.evaluate(
    () => document.querySelector("[data-last-played]")?.closest("li")?.getAttribute("data-queue-item"),
  );
  console.log(`  after a reopen the marker reads "${marker}" on ${markerUrl}`);
  assert.equal(marker, "上次在听");
  assert.equal(markerUrl, "/demo/track-2.wav");

  const continueLabel = (await page.locator("[data-continue-last]").innerText()).trim();
  console.log(`  and the queue offers one click: "${continueLabel}"`);
  assert.match(continueLabel, /继续上次/, `no one-click continue: ${continueLabel}`);

  await page.locator("[data-continue-last]").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".music-queue li.playing")?.getAttribute("data-queue-item") ===
      "/demo/track-2.wav",
    null,
    { timeout: 10000 },
  );
  console.log("  clicking it moved playback to that song");

  // -- 6. the stores are keyed, not global -------------------------------------------
  const volumeKeys = Object.keys(await store(VOLUME_STORE));
  console.log(`  volume keys in storage: ${JSON.stringify(volumeKeys)}`);
  assert.deepEqual(volumeKeys, ["demo:album"], "the volume is not filed under a source key");
  const resumeKeys = Object.keys(await store(RESUME_STORE));
  console.log(`  resume keys in storage: ${JSON.stringify(resumeKeys)}`);
  assert.ok(resumeKeys.includes("/demo/track-2.wav"), "positions are not filed per song");

  await page.screenshot({ path: path.join(outDir, "music-memory.png"), fullPage: true });
  console.log("  screenshot: test-results/music-memory.png");
} catch (error) {
  failed = true;
  console.error("music memory test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "music-memory-failure.png"), fullPage: true });
    console.error("  failure screenshot: test-results/music-memory-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);