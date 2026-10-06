// Playback failure: told apart, and actionable.
//
//   node scripts/music-failfast-test.mjs
//
// Needs `pnpm dev` running.
//
// The audio comes from a temporary HTTP server this script starts, because the
// interesting cases are all about how the server answers:
//
//   /good.wav      a real 3-second tone — the "next song" to skip to
//   /gone.wav      404 — the address is not there
//   /notaudio.txt  200 with text/html — something answered, but not audio
//   /truncated.wav headers promise more bytes than are sent, then the socket
//                   is cut: the load starts and then dies mid-stream
//
// Every assertion reads the element or the DOM: the `MediaError.code` the
// browser reported, the kind the player turned that into, and what `<audio>`
// actually did after 「跳过这一首」. Nothing here is satisfied by a string
// changing.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const pageUrl = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";

/** 8-bit unsigned mono PCM at 8 kHz — the same shape the demo fixtures use. */
function tone({ seconds = 3, hz = 440, rate = 8000 }) {
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

const good = tone({ seconds: 3, hz: 440 });

const server = http.createServer((req, res) => {
  const name = (req.url || "").replace(/^\//, "");
  if (name === "good.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": good.length });
    res.end(good);
    return;
  }
  if (name === "gone.wav") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no such track");
    return;
  }
  if (name === "notaudio.txt") {
    // Something answered, but it is a web page rather than audio.
    const body = "<!doctype html><title>not audio</title>";
    res.writeHead(200, { "Content-Type": "text/html", "Content-Length": body.length });
    res.end(body);
    return;
  }
  if (name === "truncated.wav") {
    // Promises far more than it sends, then drops the connection: the load
    // starts and dies part way through.
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": good.length * 4 });
    res.write(good.subarray(0, 512));
    res.socket?.destroy();
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`  serving one real tone and three ways of failing, at ${base}`);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.MUSIC_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
let failed = false;

/** Open the player with a given queue. */
const open = async (tracks) => {
  await page.goto(`${pageUrl}?tracks=${encodeURIComponent(JSON.stringify(tracks))}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
  await page.evaluate(() => {
    for (const key of ["serious.musicQueue.v1", "serious.musicResume.v1", "serious.musicLastPlayed.v1"]) {
      localStorage.removeItem(key);
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
};

/** Click a queue row and wait for the element to be playing *that* track. */
const playRow = async (index) => {
  await page.locator(".music-queue li").nth(index).click();
  await page.waitForFunction(
    (i) =>
      document
        .querySelector(".music-queue li.playing")
        ?.getAttribute("data-queue-index") === String(i),
    index,
    { timeout: 5000 },
  );
};

/** What the element is really doing, plus what the player says about it. */
const state = () =>
  page.evaluate(() => {
    const el = document.querySelector(".music audio");
    const box = document.querySelector("[data-failure-kind]");
    return {
      src: (el.getAttribute("src") || "").split("/").pop(),
      paused: el.paused,
      playing: document.querySelector(".music")?.getAttribute("data-playing"),
      mediaErrorCode: el.error ? el.error.code : null,
      failureKind: box?.getAttribute("data-failure-kind") ?? null,
      failureCode: box?.getAttribute("data-failure-code") ?? null,
      title: document.querySelector("[data-failure-title]")?.textContent?.trim() ?? null,
      hint: document.querySelector("[data-failure-hint]")?.textContent?.trim() ?? null,
      skipDisabled: document.querySelector("[data-skip-failed]")?.disabled ?? null,
      skipUnavailable: !!document.querySelector("[data-skip-unavailable]"),
    };
  });

/** Wait for the player to report a failure, and return the whole picture. */
const waitForFailure = async () => {
  await page.waitForSelector("[data-failure-kind]", { timeout: 20000 });
  return state();
};

const seen = {};

try {
  // -- a 404 in the middle of the queue ---------------------------------------
  // Broken first, real second: 「跳过这一首」 has somewhere to go.
  await open([
    { url: `${base}/gone.wav`, title: "坏的一首（404）" },
    { url: `${base}/good.wav`, title: "好的一首" },
    { url: `${base}/notaudio.txt`, title: "坏的一首（不是音频）" },
  ]);

  await playRow(0);
  const gone = await waitForFailure();
  seen["404"] = gone;
  console.log(
    `  404:            MediaError.code=${gone.mediaErrorCode} → kind="${gone.failureKind}" ` +
      `code="${gone.failureCode}" · 「${gone.title}」`,
  );
  console.log(`                  ${gone.hint}`);
  assert.notEqual(gone.failureKind, null, "no failure was reported at all");
  assert.equal(gone.skipDisabled, false, "跳过这一首 is disabled although there is a next track");
  assert.equal(gone.skipUnavailable, false, "the no-next-track note shows too early");

  // -- skipping really moves and really plays ---------------------------------
  const beforeSkip = gone.src;
  await page.locator("[data-skip-failed]").click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".music audio");
      return (el.getAttribute("src") || "").includes("good.wav") && el.paused === false;
    },
    null,
    { timeout: 10000 },
  );
  const afterSkip = await state();
  console.log(
    `  跳过这一首:      src ${beforeSkip} → ${afterSkip.src}, paused=${afterSkip.paused}, ` +
      `data-playing=${afterSkip.playing}, failure still shown=${afterSkip.failureKind !== null}`,
  );
  assert.equal(afterSkip.src, "good.wav", "skipping did not move to the next track");
  assert.equal(afterSkip.paused, false, "skipping did not start playback");
  assert.equal(afterSkip.playing, "1", "the player still believes it is paused");
  assert.equal(afterSkip.failureKind, null, "the failure stayed on screen after skipping");

  // -- a page that is not audio, at the end of the queue -----------------------
  await playRow(2);
  const notAudio = await waitForFailure();
  seen["not-audio"] = notAudio;
  console.log(
    `  不是音频:        MediaError.code=${notAudio.mediaErrorCode} → kind="${notAudio.failureKind}" ` +
      `code="${notAudio.failureCode}" · 「${notAudio.title}」`,
  );
  console.log(`                  ${notAudio.hint}`);
  assert.equal(notAudio.skipDisabled, true, "跳过这一首 is live although it is the last track");
  assert.equal(notAudio.skipUnavailable, true, "nothing explains why skipping is unavailable");
  const endText = await page.locator("[data-skip-unavailable]").innerText();
  console.log(`                  末首说明：「${endText.trim()}」`);
  assert.match(endText, /最后一首/, `the last-track note says nothing useful: ${endText}`);

  // -- the queue stays usable while a failure is on screen ---------------------
  await page.locator(".music-queue li").nth(1).click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".music audio");
      return (el.getAttribute("src") || "").includes("good.wav") && el.paused === false;
    },
    null,
    { timeout: 10000 },
  );
  const afterJump = await state();
  console.log(`  报错中跳队列:    src=${afterJump.src}, paused=${afterJump.paused}, 报错还在=${afterJump.failureKind !== null}`);
  assert.equal(afterJump.failureKind, null, "the previous song's failure stayed on screen");
  assert.equal(afterJump.paused, false, "jumping from a failure did not start playback");

  // -- a stream that dies part way through -------------------------------------
  await open([
    { url: `${base}/truncated.wav`, title: "坏的一首（中途断）" },
    { url: `${base}/good.wav`, title: "好的一首" },
  ]);
  await playRow(0);
  let truncated = null;
  try {
    truncated = await waitForFailure();
  } catch {
    truncated = await state();
  }
  seen["truncated"] = truncated;
  console.log(
    `  中途断开:        MediaError.code=${truncated.mediaErrorCode} → kind="${truncated.failureKind}" ` +
      `code="${truncated.failureCode}" · 「${truncated.title ?? "（无提示）"}」`,
  );

  // -- a port where nothing is listening ----------------------------------------
  await open([
    { url: "http://127.0.0.1:9/never-there.wav", title: "坏的一首（连不上）" },
    { url: `${base}/good.wav`, title: "好的一首" },
  ]);
  await playRow(0);
  let refused = null;
  try {
    refused = await waitForFailure();
  } catch {
    refused = await state();
  }
  seen["connection-refused"] = refused;
  console.log(
    `  连不上:          MediaError.code=${refused.mediaErrorCode} → kind="${refused.failureKind}" ` +
      `code="${refused.failureCode}" · 「${refused.title ?? "（无提示）"}」`,
  );

  // -- the codes a fixture server cannot be made to produce ----------------------
  // Chromium answered 4 for every real failure above, so MEDIA_ERR_NETWORK (2)
  // and MEDIA_ERR_DECODE (3) have no honest fixture here. They are driven
  // instead by giving the element a MediaError of that code and dispatching the
  // element's own error event: the component's real handler runs, but the code
  // is supplied rather than earned. Reported as such.
  for (const code of [2, 3]) {
    await open([
      { url: `${base}/good.wav`, title: "好的一首" },
      { url: `${base}/good.wav`, title: "好的一首 2" },
    ]);
    await playRow(0);
    await page.waitForFunction(() => document.querySelector(".music audio").paused === false, null, {
      timeout: 10000,
    });
    await page.evaluate((c) => {
      const el = document.querySelector(".music audio");
      // `error` is read-only on the prototype; shadow it for this element so
      // the component's real onError sees the code under test.
      Object.defineProperty(el, "error", { value: { code: c }, configurable: true });
      el.dispatchEvent(new Event("error"));
    }, code);
    await page.waitForSelector("[data-failure-kind]", { timeout: 5000 });
    const s = await state();
    seen[`stubbed-${code}`] = s;
    console.log(`  注入 code=${code}:    kind="${s.failureKind}" · 「${s.title}」`);
  }

  // -- the messages must actually differ ---------------------------------------
  const kinds = Object.entries(seen)
    .map(([name, s]) => `${name}=${s.failureKind}`)
    .join(", ");
  console.log(`  observed: ${kinds}`);
  const distinct = new Set(Object.values(seen).map((s) => s.failureKind));
  console.log(`  distinct kinds observed: ${distinct.size} → ${[...distinct].join(", ")}`);
  assert.ok(
    distinct.size >= 2,
    `every failure produced the same kind (${[...distinct].join(", ")}) — the classes are not apart`,
  );
  // The old wording collapsed everything into one sentence with an 「或」 in it.
  for (const [name, s] of Object.entries(seen)) {
    if (!s.title) continue;
    assert.ok(!/源可能已失效，或该格式不被支持/.test(s.title), `${name} still shows the old sentence`);
  }

  // -- retry does not invent a different verdict for the same track -------------
  await open([
    { url: `${base}/gone.wav`, title: "坏的一首（404）" },
    { url: `${base}/good.wav`, title: "好的一首" },
  ]);
  await playRow(0);
  const first = await waitForFailure();
  await page.locator("[data-retry-failed]").click();
  await page.waitForSelector("[data-failure-kind]", { timeout: 20000 });
  const retried = await state();
  console.log(
    `  重试同一首:      kind "${first.failureKind}" → "${retried.failureKind}" ` +
      `(code ${first.mediaErrorCode} → ${retried.mediaErrorCode})`,
  );
  assert.equal(retried.failureKind, first.failureKind, "retrying the same track changed its verdict");

  await page.screenshot({ path: path.join(outDir, "music-failfast.png"), fullPage: true });
  console.log("  screenshot: test-results/music-failfast.png");
} catch (error) {
  failed = true;
  console.error("music failfast test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "music-failfast-failure.png"), fullPage: true });
    console.error("  failure screenshot: test-results/music-failfast-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);