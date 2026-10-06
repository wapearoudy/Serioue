// Keyboard shortcuts and subtitle appearance, measured on the live element.
//
//   node scripts/video-ux-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:video` already generated.
//
// What is asserted here is the *element*, never the label: `video.paused`,
// `video.currentTime`, `video.volume`, `video.muted`, the computed style of the
// caption, and the raw contents of localStorage. A shortcut that only changed
// some on-screen text would fail every assertion in this file.
//
//   - every shortcut moves the element, and says so in an aria-live region
//   - focus in a text box: space types a space, the video keeps playing
//   - a menu is open: `k` does not pause anything
//   - subtitles: size / position / background change the computed style, are
//     stored per source, and a different source reads a different set

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.VIDEO_PREVIEW_URL || "http://localhost:1420/video-preview.html";
const STYLE_STORE = "serious.videoSubtitleStyle.v1";
const SHORTCUT_STORE = "serious.videoShortcuts.v1";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.VIDEO_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

/** Everything the shortcuts are supposed to move, in one read. */
const state = () =>
  page.evaluate(() => {
    const v = document.querySelector(".player-wrap video");
    return {
      paused: v.paused,
      currentTime: v.currentTime,
      volume: v.volume,
      muted: v.muted,
      fullscreen: !!document.fullscreenElement,
    };
  });

/**
 * A trusted-ish key press: a real `KeyboardEvent` on the window, exactly as the
 * browser would deliver it, rather than a Playwright key press (which would
 * first move focus somewhere).
 */
const press = (key) =>
  page.evaluate((k) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  }, key);

const announcement = () =>
  page.evaluate(
    () => document.querySelector("[data-announcement]")?.textContent?.trim() ?? "",
  );

/** The caption's computed style, or null when no cue is on screen. */
const caption = () =>
  page.evaluate(() => {
    const el = document.querySelector("[data-subtitle-text]");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      fontSize: cs.fontSize,
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      // Relative to the picture, so "top / middle / bottom" is comparable
      // whatever the window size is.
      topRatio: box.top / Math.max(1, window.innerHeight),
    };
  });

const store = (k) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), k);

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".player-extras button:has-text('画质')", { timeout: 25000 });
  await page.evaluate(
    ([s, h]) => {
      localStorage.removeItem(s);
      localStorage.removeItem(h);
    },
    [STYLE_STORE, SHORTCUT_STORE],
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".player-extras button:has-text('画质')", { timeout: 25000 });

  await page.evaluate(() => document.querySelector(".player-wrap video").play());
  await page.waitForFunction(
    () => document.querySelector(".player-wrap video").currentTime > 0.2,
    null,
    { timeout: 15000 },
  );

  // -- 空格 / k: play and pause -------------------------------------------------
  const beforeSpace = await state();
  await press(" ");
  await page.waitForFunction(
    () => document.querySelector(".player-wrap video").paused === true,
    null,
    { timeout: 5000 },
  );
  const afterSpace = await state();
  console.log(`  空格: paused ${beforeSpace.paused} → ${afterSpace.paused}, said "${await announcement()}"`);
  assert.equal(beforeSpace.paused, false, "the video was not playing before the space bar");
  assert.equal(afterSpace.paused, true);

  await press("k");
  await page.waitForFunction(
    () => document.querySelector(".player-wrap video").paused === false,
    null,
    { timeout: 5000 },
  );
  const afterK = await state();
  console.log(`  k:    paused true → ${afterK.paused}, said "${await announcement()}"`);
  assert.equal(afterK.paused, false);

  // -- ← / →: ten seconds each, relative to where the playhead already is --------
  // The fixture is 12.1 s long and the step is 10 s, so most pairs land on a
  // clamp. That is itself worth asserting: a seek that runs past the end should
  // stop at the end, not wrap or error.
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").currentTime = 1;
  });
  const beforeRight = await state();
  await press("ArrowRight");
  await page.waitForTimeout(120);
  const afterRight = await state();
  console.log(
    `  →:    currentTime ${beforeRight.currentTime.toFixed(2)} → ${afterRight.currentTime.toFixed(2)}, ` +
      `said "${await announcement()}"`,
  );
  assert.ok(
    Math.abs(afterRight.currentTime - (beforeRight.currentTime + 10)) < 0.6,
    `→ did not move ten seconds (${beforeRight.currentTime} → ${afterRight.currentTime})`,
  );

  // Pressing again is relative to the *new* position, so it walks back 10.
  await press("ArrowLeft");
  await page.waitForTimeout(120);
  const afterLeft = await state();
  console.log(`  ←:    currentTime ${afterRight.currentTime.toFixed(2)} → ${afterLeft.currentTime.toFixed(2)}`);
  assert.ok(
    Math.abs(afterLeft.currentTime - (afterRight.currentTime - 10)) < 0.6,
    `← did not move back ten seconds (${afterRight.currentTime} → ${afterLeft.currentTime})`,
  );

  // Both ends clamp instead of running away.
  await press("ArrowLeft");
  await press("ArrowLeft");
  await page.waitForTimeout(120);
  const clampedStart = await state();
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").currentTime = 8;
  });
  await press("ArrowRight");
  await press("ArrowRight");
  await page.waitForTimeout(120);
  const clampedEnd = await state();
  console.log(
    `  clamps: →→ from 8s lands at ${clampedEnd.currentTime.toFixed(2)}s, ` +
      `←← lands at ${clampedStart.currentTime.toFixed(2)}s`,
  );
  assert.ok(clampedStart.currentTime >= 0 && clampedStart.currentTime < 0.5, "seeking back went negative");
  assert.ok(
    clampedEnd.currentTime > 12 && clampedEnd.currentTime <= 12.2,
    `seeking past the end did not stop at the end (${clampedEnd.currentTime})`,
  );

  // -- ↑ / ↓: volume, on the element --------------------------------------------
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").volume = 0.5;
  });
  const beforeUp = await state();
  await press("ArrowUp");
  await page.waitForTimeout(80);
  const afterUp = await state();
  await press("ArrowDown");
  await page.waitForTimeout(80);
  await press("ArrowDown");
  await page.waitForTimeout(80);
  const afterDown = await state();
  console.log(
    `  ↑:    volume ${beforeUp.volume.toFixed(2)} → ${afterUp.volume.toFixed(2)}; ` +
      `↓↓ → ${afterDown.volume.toFixed(2)}, said "${await announcement()}"`,
  );
  assert.ok(Math.abs(afterUp.volume - (beforeUp.volume + 0.05)) < 0.005, "↑ did not add 5%");
  assert.ok(Math.abs(afterDown.volume - (afterUp.volume - 0.1)) < 0.005, "↓↓ did not subtract 10%");

  // -- m: mute -------------------------------------------------------------------
  const beforeM = await state();
  await press("m");
  await page.waitForTimeout(80);
  const afterM = await state();
  await press("m");
  await page.waitForTimeout(80);
  const afterM2 = await state();
  console.log(`  m:    muted ${beforeM.muted} → ${afterM.muted} → ${afterM2.muted}, said "${await announcement()}"`);
  assert.equal(afterM.muted, true, "m did not mute");
  assert.equal(afterM2.muted, false, "m did not unmute");

  // -- digits: jump to 0%–90% ------------------------------------------------------
  await press("5");
  await page.waitForTimeout(150);
  const at50 = await state();
  console.log(`  5:    currentTime → ${at50.currentTime.toFixed(2)} of 12.1s, said "${await announcement()}"`);
  assert.ok(
    Math.abs(at50.currentTime / 12.1 - 0.5) < 0.02,
    `5 should land near the middle, it landed at ${at50.currentTime.toFixed(2)}`,
  );

  // -- f: fullscreen, and Escape is the browser's to handle -------------------------
  const beforeF = await state();
  await press("f");
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  const afterF = await state();
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
  console.log(`  f:    fullscreen ${beforeF.fullscreen} → ${afterF.fullscreen}, said "${await announcement()}"`);
  assert.equal(afterF.fullscreen, true, "f did not enter fullscreen");

  // Escape must not be swallowed: if it were, leaving fullscreen would be broken.
  await press("f");
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
  console.log("  Esc is left to the browser (fullscreen could still be left)");

  // -- c: subtitles ----------------------------------------------------------------
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").currentTime = 1;
  });
  await page.waitForFunction(() => !!document.querySelector("[data-subtitle-overlay]"), null, {
    timeout: 10000,
  });
  const beforeC = (await state()).paused;
  await press("c");
  await page.waitForFunction(() => !document.querySelector("[data-subtitle-overlay]"), null, {
    timeout: 5000,
  });
  const afterC = (await state()).paused;
  await press("c");
  await page.waitForFunction(() => !!document.querySelector("[data-subtitle-overlay]"), null, {
    timeout: 5000,
  });
  console.log(`  c:    caption hidden then shown again, paused stayed ${beforeC} → ${afterC}`);
  assert.equal(afterC, beforeC, "toggling captions must not pause the video");

  // -- focus yields to typing ---------------------------------------------------------
  await page.evaluate(() => document.querySelector(".player-wrap video").play());
  await page.waitForFunction(
    () => document.querySelector(".player-wrap video").paused === false,
    null,
    { timeout: 5000 },
  );
  await page.locator("[data-preview-note]").focus();
  await page.keyboard.type("a b");
  await page.waitForTimeout(120);
  const typed = await page.locator("[data-preview-note]").inputValue();
  const whileTyping = await state();
  console.log(`  typing "a b" into the note field: value "${typed}", paused=${whileTyping.paused}`);
  assert.equal(typed, "a b", `the field did not receive the keystrokes: "${typed}"`);
  assert.equal(whileTyping.paused, false, "the player paused while someone was typing");
  // A digit typed in the box must not seek either. Pause first: while the video
  // is playing its currentTime moves on its own, and comparing two reads would
  // be measuring the clock rather than the shortcut.
  await page.evaluate(() => document.querySelector(".player-wrap video").pause());
  await page.waitForTimeout(120);
  const beforeDigit = await state();
  await page.locator("[data-preview-note]").focus();
  await page.keyboard.type("7");
  await page.waitForTimeout(120);
  const afterDigit = await state();
  const fieldAfterDigit = await page.locator("[data-preview-note]").inputValue();
  console.log(
    `  a "7" typed into the box: field "${fieldAfterDigit}", currentTime ` +
      `${beforeDigit.currentTime.toFixed(3)} → ${afterDigit.currentTime.toFixed(3)}`,
  );
  assert.equal(fieldAfterDigit, "a b7", "the digit did not reach the text box");
  assert.equal(
    afterDigit.currentTime,
    beforeDigit.currentTime,
    `a digit typed into a text box seeked the video (${beforeDigit.currentTime} → ${afterDigit.currentTime})`,
  );
  await page.locator("[data-preview-note]").blur();

  // -- a menu is open: letters belong to the menu ---------------------------------------
  await page.locator("[data-shortcuts-toggle]").click();
  await page.waitForSelector("[data-shortcuts-panel]", { timeout: 5000 });
  const beforeMenuKey = await state();
  await press("k");
  await page.waitForTimeout(150);
  const afterMenuKey = await state();
  console.log(
    `  with the shortcut panel open: paused ${beforeMenuKey.paused} → ${afterMenuKey.paused}, ` +
      `currentTime ${beforeMenuKey.currentTime.toFixed(2)} → ${afterMenuKey.currentTime.toFixed(2)}`,
  );
  assert.equal(afterMenuKey.paused, true, "k paused the video while a menu was open");

  await page.locator("[data-shortcuts-panel] [data-shortcuts-enabled]").click();
  // The flag is a bare "0"/"1", not a JSON object: parsing it as one would
  // read `undefined` and quietly pass the next check.
  const shortcutFlag = await page.evaluate((k) => localStorage.getItem(k), SHORTCUT_STORE);
  console.log(`  ${SHORTCUT_STORE} = ${JSON.stringify(shortcutFlag)}`);
  assert.equal(shortcutFlag, "0", "the toggle did not persist");
  await page.locator("[data-shortcuts-toggle]").click();
  const beforeOff = await state();
  await press("k");
  await page.waitForTimeout(150);
  const afterOff = await state();
  console.log(`  with shortcuts off: paused ${beforeOff.paused} → ${afterOff.paused}`);
  assert.equal(afterOff.paused, beforeOff.paused, "a shortcut still fired after they were turned off");
  await page.locator("[data-shortcuts-toggle]").click();
  await page.locator("[data-shortcuts-panel] [data-shortcuts-enabled]").click();
  await page.locator("[data-shortcuts-toggle]").click();

  // -- subtitle appearance ---------------------------------------------------------------
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").currentTime = 1;
  });
  await page.waitForFunction(() => !!document.querySelector("[data-subtitle-overlay]"), null, {
    timeout: 10000,
  });
  const captionDefault = await caption();
  console.log(
    `  default caption: "${captionDefault.text}" fontSize=${captionDefault.fontSize} ` +
      `background=${captionDefault.backgroundColor} topRatio=${captionDefault.topRatio.toFixed(2)}`,
  );
  assert.equal(captionDefault.fontSize, "22px", "the default size is not the documented 22px");
  assert.match(captionDefault.backgroundColor, /rgba\(0, 0, 0, 0\.62\)/, "the default has no plate");

  await page.locator("[data-subtitle-toggle]").click();
  await page.waitForSelector("[data-subtitle-menu]", { timeout: 5000 });
  await page.locator('[data-subtitle-size-option="huge"]').click();
  await page.waitForTimeout(120);
  const captionHuge = await caption();
  console.log(`  特大: fontSize=${captionHuge.fontSize}`);
  assert.equal(captionHuge.fontSize, "38px", `the size change did not reach the computed style`);

  await page.locator('[data-subtitle-position-option="top"]').click();
  await page.waitForTimeout(120);
  const captionTop = await caption();
  await page.locator('[data-subtitle-position-option="middle"]').click();
  await page.waitForTimeout(120);
  const captionMiddle = await caption();
  await page.locator('[data-subtitle-position-option="bottom"]').click();
  await page.waitForTimeout(120);
  const captionBottom = await caption();
  console.log(
    `  position top=${captionTop.topRatio.toFixed(2)} middle=${captionMiddle.topRatio.toFixed(2)} ` +
      `bottom=${captionBottom.topRatio.toFixed(2)}`,
  );
  assert.ok(
    captionTop.topRatio < captionMiddle.topRatio && captionMiddle.topRatio < captionBottom.topRatio,
    "the caption did not actually move between top / middle / bottom",
  );

  await page.locator("[data-subtitle-background]").click();
  await page.waitForTimeout(120);
  const captionNoBg = await caption();
  console.log(`  background off: ${captionNoBg.backgroundColor}`);
  assert.equal(captionNoBg.backgroundColor, "rgba(0, 0, 0, 0)", "the plate did not go away");
  await page.locator("[data-subtitle-background]").click();
  await page.waitForTimeout(120);

  const savedMaster = (await store(STYLE_STORE))["demo:master"];
  console.log(`  localStorage ${STYLE_STORE} = ${JSON.stringify(savedMaster)}`);
  assert.equal(savedMaster.size, "huge");
  assert.equal(savedMaster.position, "bottom");
  assert.equal(savedMaster.background, true);

  // -- a different source reads a different set -----------------------------------------
  await page.locator("[data-subtitle-toggle]").click();
  await page.selectOption("select", { label: "HLS 单码率 360p" });
  // Wait for the new stream to be usable rather than for a clock that is not
  // running: the player was paused, so currentTime would never move on its own.
  await page.waitForFunction(
    () => {
      const v = document.querySelector(".player-wrap video");
      return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    },
    null,
    { timeout: 25000 },
  );
  await page.evaluate(async () => {
    const v = document.querySelector(".player-wrap video");
    v.currentTime = 1;
    await v.play().catch(() => {});
  });
  await page.waitForFunction(() => !!document.querySelector("[data-subtitle-overlay]"), null, {
    timeout: 10000,
  });
  const captionOther = await caption();
  console.log(
    `  the other source: fontSize=${captionOther.fontSize} background=${captionOther.backgroundColor}`,
  );
  assert.equal(
    captionOther.fontSize,
    "22px",
    "the other source inherited the first one's subtitle size",
  );
  assert.match(captionOther.backgroundColor, /rgba\(0, 0, 0, 0\.62\)/);

  // Change it there, and the first source must keep its own.
  await page.locator("[data-subtitle-toggle]").click();
  await page.locator('[data-subtitle-size-option="small"]').click();
  await page.waitForTimeout(120);
  const savedBoth = await store(STYLE_STORE);
  console.log(`  both sources stored: ${JSON.stringify(savedBoth)}`);
  assert.equal(savedBoth["demo:master"].size, "huge");
  assert.equal(savedBoth["demo:360p"].size, "small");

  await page.selectOption("select", { label: "HLS 多码率" });
  await page.waitForFunction(
    () => {
      const v = document.querySelector(".player-wrap video");
      return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    },
    null,
    { timeout: 25000 },
  );
  await page.evaluate(async () => {
    const v = document.querySelector(".player-wrap video");
    v.currentTime = 1;
    await v.play().catch(() => {});
  });
  await page.waitForFunction(() => !!document.querySelector("[data-subtitle-overlay]"), null, {
    timeout: 10000,
  });
  const captionBack = await caption();
  console.log(`  back on the first source: fontSize=${captionBack.fontSize}`);
  assert.equal(captionBack.fontSize, "38px", "the first source lost its own subtitle size");

  await page.screenshot({ path: path.join(outDir, "video-ux.png"), fullPage: true });
  console.log("  screenshot: test-results/video-ux.png");
} catch (error) {
  failed = true;
  console.error("video ux test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "video-ux-failure.png"), fullPage: true });
    console.error("  failure screenshot: test-results/video-ux-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);