// Drives the real TtsPanel in a real browser.
//
//   node scripts/reader-tts-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-preview.html).
//
// What it proves — against `window.speechSynthesis` itself, not against the
// panel's own claims:
//   - pressing ▶ makes the engine actually speak
//   - the sentence being spoken carries `.sentence-active`, and it is the
//     sentence whose text the engine was given
//   - the engine advances on its own from one sentence to the next
//   - a silent stall (the fifteen-second Chrome bug, simulated by cancelling
//     behind the panel's back) is renewed by the heartbeat, and the renewal is
//     counted
//   - 暂停 stops the engine, 停止 stops it and clears the highlight
//   - closing the panel leaves nothing speaking
//   - switching article cancels the voice and resets the position
//   - a reader scroll stops narration and re-bases onto the new position
//   - a machine with no voice list shows a sentence instead of an empty panel
//
// HONEST LIMITS, printed in the output:
//   This machine's speech engine is never listened to. A headless/edge browser
//   proves that the API accepts an utterance and reports `speaking`; it cannot
//   prove that sound came out of the speakers. What is verified here is the
//   state machine, the highlight targeting and the stall recovery — not audibility.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base = process.env.READER_PREVIEW_URL || "http://localhost:1420/reader-preview.html";
// A one-second watchdog keeps the stall test quick. The component's own default
// is asserted to still be ten seconds.
const url = `${base}?heartbeat=1000`;

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_TTS_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
let failed = false;

/** Wait until the sentence being read is the one carrying the highlight. */
async function waitForHighlight(cursor) {
  await page.waitForFunction(
    (want) =>
      document.querySelector(".sentence-active")?.getAttribute("data-sentence-index") === String(want),
    cursor,
    { timeout: 5000 },
  );
}

/** What the engine itself reports right now. */
const engineState = () =>
  page.evaluate(() => ({
    speaking: window.speechSynthesis.speaking,
    pending: window.speechSynthesis.pending,
  }));

/** The panel's own state, as data attributes. */
const panelState = () =>
  page.evaluate(() => {
    const el = document.querySelector(".tts-panel");
    if (!el) return null;
    const active = document.querySelector(".sentence-active");
    return {
      available: el.dataset.ttsAvailable,
      voices: Number(el.dataset.ttsVoices),
      status: el.dataset.ttsStatus,
      cursor: Number(el.dataset.ttsCursor),
      start: Number(el.dataset.ttsStart),
      total: Number(el.dataset.ttsTotal),
      renewals: Number(el.dataset.ttsRenewals),
      heartbeat: Number(el.dataset.ttsHeartbeat),
      activeIndex: active ? Number(active.getAttribute("data-sentence-index")) : null,
      activeText: active ? active.textContent.trim() : "",
      progress: document.querySelector(".tts-progress")?.textContent?.trim() ?? "",
      note: document.querySelector(".tts-note")?.textContent?.trim() ?? "",
    };
  });

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".tts-panel", { timeout: 15000 });
  await page.waitForSelector("[data-sentence-index]", { timeout: 15000 });

  // -- what this machine can actually do -------------------------------------
  const initial = await panelState();
  console.log(`  voices on this machine: ${initial.voices}`);
  console.log(`  sentences in the page:  ${initial.total}`);
  assert.ok(initial.total > 10, `expected a real article, got ${initial.total} sentences`);

  if (initial.available !== "1") {
    // No TTS engine here: assert the panel says so, and stop. Everything below
    // is about speech that cannot happen on this machine.
    assert.match(initial.note, /没有可用的语音引擎|不支持语音合成/, `no plain explanation: ${initial.note}`);
    assert.equal(
      await page.locator('[data-tts-action="play"]').isDisabled(),
      true,
      "play must be disabled when there is no voice",
    );
    console.log(`  no voice engine here: "${initial.note}"`);
    console.log("  LIMIT: no TTS voice on this machine — state machine not exercised.");
  } else {
    // -- the component's own default is the documented one -------------------
    assert.equal(initial.heartbeat, 1000, "the preview should have shortened the watchdog");

    const defaultHeartbeat = await page.evaluate(async () => {
      const mod = await import("/src/components/TtsPanel.tsx");
      return mod.HEARTBEAT_MS;
    });
    assert.equal(defaultHeartbeat, 10000, `the shipped watchdog is ${defaultHeartbeat}ms, not 10s`);
    console.log(`  watchdog default in the component: ${defaultHeartbeat}ms`);

    // -- play ---------------------------------------------------------------
    await page.click('[data-tts-action="play"]');
    await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 5000 });
    const speaking = await engineState();
    assert.equal(speaking.speaking, true, "the engine is not speaking after ▶");

    const playing = await panelState();
    assert.equal(playing.status, "playing");
    assert.equal(playing.activeIndex, playing.cursor, "the highlight is not on the current sentence");
    assert.ok(playing.activeText.length > 0, "the highlighted sentence has no text");
    assert.ok(
      playing.progress.includes(`${playing.total}`),
      `the progress does not show the sentence total: ${playing.progress}`,
    );
    console.log(`  ▶ sentence ${playing.cursor + 1}/${playing.total}: "${playing.activeText.slice(0, 24)}…"`);
    console.log(`  engine: speaking=${speaking.speaking} pending=${speaking.pending}`);

    // The highlighted sentence must be the one handed to the engine: capture
    // the utterance by spying on speak() and compare texts.
    const spokenFirst = await page.evaluate(async () => {
      const synth = window.speechSynthesis;
      const original = synth.speak.bind(synth);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Stop, let the panel re-render, then play again — two clicks in the same
      // tick would both see the same stale state.
      document.querySelector('[data-tts-action="stop"]')?.click();
      await wait(200);
      return await new Promise((resolve) => {
        synth.speak = (u) => {
          synth.speak = original;
          resolve(u.text);
          original(u);
        };
        document.querySelector('[data-tts-action="play"]')?.click();
        setTimeout(() => resolve(null), 3000);
      });
    });
    assert.ok(spokenFirst, "the engine was never handed an utterance");
    const afterSpoken = await panelState();
    assert.equal(
      afterSpoken.activeText,
      spokenFirst.trim(),
      `the highlight shows "${afterSpoken.activeText}" but the engine is reading "${spokenFirst}"`,
    );
    console.log(`  the highlighted sentence is exactly what was handed to speak()`);

    // -- it advances on its own ---------------------------------------------
    const before = await panelState();
    await page.waitForFunction(
      (from) => Number(document.querySelector(".tts-panel")?.getAttribute("data-tts-cursor")) > from,
      before.cursor,
      { timeout: 25000 },
    );
    const after = await panelState();
    assert.ok(after.cursor > before.cursor, `the cursor did not move (${before.cursor} -> ${after.cursor})`);
    // The cursor renders before the effect that moves the class onto the new
    // sentence, so wait for the highlight to catch up rather than sampling once.
    await waitForHighlight(after.cursor);
    const settled = await panelState();
    assert.equal(
      settled.activeIndex,
      settled.cursor,
      "the highlight did not follow the cursor to the new sentence",
    );
    console.log(`  advanced on its own: ${before.cursor} -> ${after.cursor}`);

    // -- the fifteen-second stall -------------------------------------------
    // Simulated honestly: the engine is cancelled from outside the panel, which
    // is what Chrome does silently. Nothing in the panel is told.
    //
    // It has to be done while an utterance is actually in flight — cancel during
    // the pause between sentences is already recovered by the pending timer, so
    // it would prove nothing about the watchdog.
    let renewed = null;
    const renewalsBefore = (await panelState()).renewals;
    for (let attempt = 0; attempt < 4 && !renewed; attempt++) {
      await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 8000 });
      await page.evaluate(() => window.speechSynthesis.cancel());
      await page.waitForFunction(
        () => window.speechSynthesis.speaking === true,
        null,
        { timeout: 4000 },
      ).catch(() => {
        /* caught below by the renewal check */
      });
      renewed = await page
        .waitForFunction(
          (from) => Number(document.querySelector(".tts-panel")?.getAttribute("data-tts-renewals")) > from,
          renewalsBefore,
          { timeout: 6000 },
        )
        .then(() => panelState())
        .catch(() => null);
    }
    assert.ok(renewed, `the heartbeat never renewed a cancelled utterance (renewals stayed at ${renewalsBefore})`);
    assert.ok(renewed.renewals > renewalsBefore, "the heartbeat did not count a renewal");
    assert.equal(renewed.status, "playing", "the panel gave up instead of renewing");
    console.log(
      `  silent stall renewed: renewals ${renewalsBefore} -> ${renewed.renewals}, speaking again at sentence ${renewed.cursor}`,
    );

    // -- pause ---------------------------------------------------------------
    await page.click('[data-tts-action="play"]'); // the button is 暂停 while playing
    await page.waitForFunction(() => window.speechSynthesis.speaking === false, null, { timeout: 5000 });
    const paused = await panelState();
    assert.equal(paused.status, "paused", `expected paused, got ${paused.status}`);
    assert.equal((await engineState()).speaking, false, "the engine is still speaking after 暂停");
    console.log("  ⏸ paused: engine silent, cursor kept for 继续");

    // -- stop clears the highlight -------------------------------------------
    await page.click('[data-tts-action="stop"]');
    const stopped = await panelState();
    assert.equal(stopped.status, "idle");
    // Back to where the reader is looking, not necessarily to the first sentence
    // on the page: the panel started from the first visible one.
    assert.equal(stopped.cursor, stopped.start, `stop went to ${stopped.cursor}, not back to ${stopped.start}`);
    assert.equal(stopped.activeIndex, null, `the highlight survived 停止: ${JSON.stringify(stopped)}`);
    assert.equal((await engineState()).speaking, false);
    console.log(`  ⏹ stop: engine silent, back to sentence ${stopped.start + 1}, highlight gone`);

    // -- a reader scroll re-bases and stops -----------------------------------
    await page.click('[data-tts-action="play"]');
    await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 5000 });
    await page.evaluate(() => {
      const el = document.querySelector(".reader-scroll");
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForFunction(() => window.speechSynthesis.speaking === false, null, { timeout: 5000 });
    const scrolled = await panelState();
    assert.equal(scrolled.status, "idle", "scrolling did not stop the narration");
    assert.equal((await engineState()).speaking, false);
    assert.ok(scrolled.cursor > 0, "the reader scrolled to the end but the cursor stayed at 0");
    assert.match(scrolled.note, /阅读位置变了/, `no explanation for the stop: ${scrolled.note}`);
    console.log(`  scrolling stopped it and re-based onto sentence ${scrolled.cursor + 1}`);

    // The stop notice is an error-shaped message, so it has to be dismissible
    // rather than sitting there until the next play.
    assert.equal(
      await page.locator('[data-tts-action="dismiss-note"]').count(),
      1,
      "the stop notice cannot be dismissed",
    );
    await page.click('[data-tts-action="dismiss-note"]');
    assert.equal(
      await page.locator('[data-tts-note="1"]').count(),
      0,
      "dismissing left the notice on screen",
    );
    console.log("  the stop notice can be dismissed");
  }

  await page.screenshot({ path: path.join(outDir, "reader-tts.png") });
  console.log("  screenshot: test-results/reader-tts.png");

  // -- unmount leaves nothing speaking ---------------------------------------
  await page.click('[data-tts-action="play"]');
  await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 5000 });
  await page.evaluate(() => {
    const btn = document.querySelector('[data-tts-action="close"]');
    btn?.click();
  });
  await page.waitForFunction(() => window.speechSynthesis.speaking === false, null, { timeout: 5000 });
  assert.equal(await page.locator(".tts-panel").count(), 0, "the panel did not close");
  console.log("  closing the panel (a real React unmount) cancelled the voice");

  // -- switching article cancels -------------------------------------------
  // The panel is keyed on the article, so opening the next chapter is a real
  // unmount of the old one. (Wiping `innerHTML` would not be: React still owns
  // the tree and no cleanup would run.)
  await page.click('[data-preview-action="tts"]');
  await page.waitForSelector(".tts-panel", { timeout: 5000 });
  await page.click('[data-tts-action="play"]');
  await page.waitForFunction(() => window.speechSynthesis.speaking === true, null, { timeout: 5000 });
  const beforeSwitch = await panelState();
  await page.getByRole("button", { name: "下一章 →" }).click();
  await page.waitForFunction(() => window.speechSynthesis.speaking === false, null, { timeout: 5000 });
  const afterSwitch = await panelState();
  assert.equal(afterSwitch.status, "idle", `a new article inherited ${afterSwitch.status}`);
  assert.equal(afterSwitch.activeIndex, null, "the highlight survived the article switch");
  assert.equal(
    afterSwitch.total,
    beforeSwitch.total,
    "the preview article is the same length; the panel must simply start over",
  );
  console.log(
    `  switching article cancelled the voice and reset to sentence ${afterSwitch.start + 1}`,
  );

  console.log(
    "  NOTE: `speaking` is the platform's own flag. Whether audio came out of the speakers cannot be observed here.",
  );
} catch (error) {
  failed = true;
  console.error("reader tts test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-tts-failure.png") });
    console.error("  failure screenshot: test-results/reader-tts-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
