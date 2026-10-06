// The voice must not stop itself while following the text.
//
//   node scripts/tts-follow-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-return-preview.html).
//
// What it proves, with runtime readings rather than code reasoning:
//
//   LEG A (long jumps): the reader vaults ~130 sentences ahead with one click
//   (「下一句」 x130, a single synchronous burst), the panel follows with a
//   multi-thousand-pixel smooth scroll — measured 1882ms for 6000px, far past
//   the old fixed 700ms `followUntil` window — and narration must STILL be
//   playing afterwards. Readings: playing status, current sentence index,
//   scroll distance covered.
//
//   LEG B (manual scroll): a real wheel event while playing must still stop
//   narration (the deliberate design — the reader takes the page back).
//   Same readings.
//
// Why a burst click and not natural playback: the defect is distance, not
// time. Natural sentence-by-sentence advance moves ~155px per follow (each
// new follow re-arms the 700ms window before the old one expires, so the
// pre-fix code survives it). Only a jump of thousands of pixels outlives a
// single window — exactly what happens in a long article when the voice
// jumps to a far sentence, and what the burst reproduces deterministically.
//
// Against the pre-fix code LEG A fails with status=idle and the note
// 「阅读位置变了，已停下；再点播放从当前屏幕继续」 — the panel halted
// itself on its own follow-scroll.
//
// The speech engine is stubbed: this machine has no system voices, so
// `speechSynthesis.getVoices/speak/cancel/speaking` are scripted in-page
// (a fake voice whose utterances never end on their own — the panel only
// moves when the script clicks 上一句/下一句 — so no timer in the test can
// be mistaken for a user scroll). What is measured is the REAL wiring —
// Reader's scroll listener, the onFollow handshake, and TtsPanel's halt —
// not the panel's own claims.
//
// Playwright's own scrolling is kept out of the measurement: the card is
// opened with a plain click (the list's own business, pinned by
// reader-return-test.mjs), `scrollIntoView` is never called by the script,
// and only the panel's follow-scroll plus one scripted real wheel event
// move the reader. LEG B's wheel runs while NO follow-scroll is in flight
// (it waits for scrolling to settle first), so it cannot land inside an
// auto-follow's protection and be misread — the flake the captain caught
// on the first version.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.TTS_FOLLOW_PREVIEW_URL || "http://localhost:1420/reader-return-preview.html";

/** Sentences vaulted in one synchronous burst (x60px each ≈ 7800px of travel). */
const JUMP_SENTENCES = 130;
/** The smooth scroll must cover at least this far to outlive the old window. */
const MIN_JUMP_PX = 2000;

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.TTS_FOLLOW_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 440 } });
let failed = false;

/** The panel's own state, as data attributes + note text. */
const panelState = () =>
  page.evaluate(() => {
    const el = document.querySelector(".tts-panel");
    if (!el) return null;
    const scroller = document.querySelector(".reader-scroll");
    return {
      status: el.dataset.ttsStatus,
      cursor: Number(el.dataset.ttsCursor),
      total: Number(el.dataset.ttsTotal),
      scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
      note: document.querySelector(".tts-note")?.textContent?.trim() ?? "",
    };
  });

/** True while a smooth scroll is still moving the reader. */
const isSettling = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const el = document.querySelector(".reader-scroll");
        let last = el.scrollTop;
        let quiet = 0;
        const tick = () => {
          if (Math.abs(el.scrollTop - last) < 1) {
            quiet += 1;
            if (quiet >= 5) return resolve(false);
          } else {
            last = el.scrollTop;
            quiet = 0;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve(true), 10000);
      }),
  );

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  // Same harness guard at the front door: if the list never renders (e.g.
  // "载入合集失败"), say HARNESS — not LEG A/B.
  try {
    await page.waitForSelector(".card", { timeout: 20000 });
  } catch {
    const chain = await page.evaluate(() => ({
      cards: document.querySelectorAll(".card").length,
      banner: document.querySelector(".banner")?.textContent?.trim()?.slice(0, 80) ?? null,
      cats: document.querySelectorAll(".cat").length,
    }));
    throw new Error(`HARNESS SETUP FAILED (not a LEG failure): the list never rendered: ${JSON.stringify(chain)}`);
  }
  // A long article: 150 paragraphs x 4 sentences = 600 sentences.
  // (The rich view only marks text nodes that split into 2+ sentences, so
  // each paragraph carries several; single-sentence paragraphs would leave
  // zero [data-sentence-index] nodes and no panel at all.)
  // Wrapping AFTER load puts this on top of the harness's own invoke
  // wrapper (see reader-position-test.mjs for why an init script sits
  // underneath it and never sees a call).
  await page.evaluate(() => {
    const inner = window.__TAURI_INTERNALS__.invoke;
    if (inner.__ttsFollowLong) return;
    const longText = Array.from(
      { length: 150 },
      (_, i) =>
        `这是第${i + 1}段第一句，用来把文章撑得很长很长。这是第${i + 1}段第二句，好让平滑滚动需要很久很久。` +
        `这是第${i + 1}段第三句，朗读会一句一句往下走。这是第${i + 1}段第四句，每一句都可能触发跟随滚动。`,
    ).join("\n");
    const longHtml = `<p>${longText.replace(/\n/g, "</p><p>")}</p>`;
    const wrapper = async (cmd, args = {}) => {
      if (cmd === "load_article") {
        const u = String(args.url ?? "");
        return {
          title: "长文跟随测试",
          final_url: u,
          html: longHtml,
          text: longText,
          media: [],
          audio: [],
        };
      }
      return inner(cmd, args);
    };
    wrapper.__ttsFollowLong = true;
    window.__TAURI_INTERNALS__.invoke = wrapper;
  });
  await page.locator(".card").first().click();
  await page.waitForSelector("article.reader", { timeout: 15000 });
  // Guard the harness, not the legs: the list must actually be there before
  // anything else runs. If THIS fails, the invoke wrapper chain (the harness's
  // module-scope wrapper vs this script's long-article wrapper — see
  // reader-position-test.mjs for the layering pitfall) never delivered, and
  // the run must say so instead of failing later as "LEG A" or "LEG B".
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector(".main-body");
      return el && el.scrollHeight - el.clientHeight > 3000;
    }, null, { timeout: 15000 });
  } catch {
    const chain = await page.evaluate(() => ({
      cards: document.querySelectorAll(".card").length,
      banner: document.querySelector(".banner")?.textContent?.trim()?.slice(0, 80) ?? null,
      longWrapped: Boolean(window.__TAURI_INTERNALS__?.invoke?.__ttsFollowLong),
      inReader: !!document.querySelector("article.reader"),
    }));
    throw new Error(`HARNESS SETUP FAILED (not a LEG failure): the long article never loaded: ${JSON.stringify(chain)}`);
  }

  // The speech engine is stubbed: this machine has no system voices.
  // Utterances NEVER end on their own — the panel only moves when the
  // script clicks 上一句/下一句 — so no timer in the test can be mistaken
  // for a user scroll.
  await page.evaluate(() => {
    const synth = window.speechSynthesis;
    synth.getVoices = () => [{ name: "FakeVoice", voiceURI: "fake://tts-follow", lang: "zh-CN" }];
    try {
      synth.dispatchEvent(new Event("voiceschanged"));
    } catch {
      /* best effort */
    }
    synth.speak = () => {
      try {
        synth.speaking = true;
      } catch {
        /* the flag may be read-only on some builds */
      }
    };
    synth.cancel = () => {
      try {
        synth.speaking = false;
      } catch {
        /* ignore */
      }
    };
  });
  const speechInfo = await page.evaluate(() => ({
    voices: (() => {
      try {
        return window.speechSynthesis.getVoices().length;
      } catch {
        return -1;
      }
    })(),
    scrollable:
      document.querySelector(".main-body")?.scrollHeight - document.querySelector(".main-body")?.clientHeight,
  }));
  console.log(`  stub engine: voices=${speechInfo.voices}, article scrollable=${speechInfo.scrollable}px`);
  assert.ok(speechInfo.voices > 0, "the stubbed voice list did not take");

  await page.evaluate(() => {
    document.querySelector('[data-reader-action="tts"]')?.click();
  });
  await page.waitForSelector(".tts-panel", { timeout: 8000 });
  const total = (await panelState()).total;
  console.log(`  panel open: ${total} sentences`);
  assert.ok(total > 300, `expected a long article, got ${total} sentences`);

  await page.evaluate(() => {
    document.querySelector('[data-tts-action="play"]')?.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".tts-panel")?.getAttribute("data-tts-status") === "playing",
    null,
    { timeout: 8000 },
  );
  // Playwright's click scrolls the button into view through the nearest
  // scrollable ancestor — the reader itself. That scroll is Playwright's, not
  // the user's and not the panel's: settle it BEFORE measuring LEG A's
  // baseline, or `travelled` (and later the wheel target) starts from a
  // moving page.
  await page.waitForTimeout(1200);

  // -- LEG A: one long vault must not stop the voice -------------------------
  const before = await panelState();
  const jumpTop = await page.evaluate((n) => {
    const btn = document.querySelector('[data-tts-action="next"]');
    const el = document.querySelector(".reader-scroll");
    const top0 = el.scrollTop;
    for (let i = 0; i < n; i++) btn.click();
    return { top0: Math.round(top0), cursor: document.querySelector(".tts-panel")?.dataset.ttsCursor };
  }, JUMP_SENTENCES);
  console.log(`  vaulted ${JUMP_SENTENCES} sentences in one burst: cursor ${before.cursor} -> ${jumpTop.cursor}`);
  // Let the follow-scroll run to completion (smooth, multi-thousand px).
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".reader-scroll");
      if (!el) return false;
      if (window.__ttsSettle) {
        const settled = el.scrollTop === window.__ttsSettle.last;
        window.__ttsSettle.last = el.scrollTop;
        return settled;
      }
      window.__ttsSettle = { last: el.scrollTop };
      return false;
    },
    null,
    { timeout: 15000, polling: 200 },
  );
  await page.evaluate(() => delete window.__ttsSettle);
  const after = await panelState();
  const travelled = after.scrollTop - before.scrollTop;
  console.log(
    `  LEG A after ${travelled}px follow-scroll: status=${after.status} ` +
      `cursor=${after.cursor} (was ${before.cursor}) scrollTop=${after.scrollTop}`,
  );
  assert.ok(travelled >= MIN_JUMP_PX, `the follow-scroll only covered ${travelled}px — not a long jump`);
  assert.equal(
    after.status,
    "playing",
    `LEG A FAILED: narration stopped itself on a ${travelled}px follow-scroll ` +
      `(cursor ${before.cursor} -> ${after.cursor}); note: "${after.note}"`,
  );

  // -- LEG B: a real wheel event must still stop the voice -------------------
  // The wheel goes through the OS input pipeline (page.mouse.wheel), not a
  // dispatched DOM event (measured: dispatched WheelEvents move nothing while
  // smooth momentum settles). Note the ordering below is deliberate: the
  // idle check comes FIRST and the scrollTop is re-read only for the report
  // afterwards — reading it between the wheel and the halt races the very
  // scroll being measured.
  const stillMoving = await isSettling();
  assert.ok(!stillMoving, "the reader was still settling before the wheel — timing unsafe");
  const beforeWheel = await panelState();
  assert.equal(beforeWheel.status, "playing", `LEG B setup failed: not playing (${beforeWheel.status})`);
  const at = await page.evaluate(() => {
    const el = document.querySelector(".reader-scroll");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(300);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(
    () => document.querySelector(".tts-panel")?.getAttribute("data-tts-status") === "idle",
    null,
    { timeout: 8000 },
  );
  const afterWheel = await panelState();
  console.log(
    `  LEG B after real wheel: status=${afterWheel.status} cursor=${afterWheel.cursor} ` +
      `(was ${beforeWheel.cursor}) scrollTop=${afterWheel.scrollTop} note="${afterWheel.note}"`,
  );
  assert.equal(afterWheel.status, "idle", `LEG B FAILED: a real wheel did not stop narration (${JSON.stringify(afterWheel)})`);
  assert.match(afterWheel.note, /阅读位置变了/, `LEG B FAILED: no explanation for the stop: "${afterWheel.note}"`);

  await page.screenshot({ path: path.join(outDir, "tts-follow.png") });
  console.log("  screenshot: test-results/tts-follow.png");
} catch (error) {
  failed = true;
  console.error("tts follow test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "tts-follow-failure.png") });
    console.error("  failure screenshot: test-results/tts-follow-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
