// The control bar's idle behaviour: a hand resting on it, a hand that left, and
// the two things the bar was missing — 快进 10 秒 and arrow keys that work when
// the focus is on the seek slider.
//
//   node scripts/video-idle-test.mjs
//
// Needs `pnpm dev` running and `pnpm demo:video` already generated.
//
// Everything asserted here is read out of the running page:
//   * the control bar's computed `opacity` and `pointer-events` — the two
//     properties that decide whether it can be seen and clicked at all
//   * `video.paused` / `video.currentTime` — never a component's own state
//   * `document.activeElement` and `document.elementFromPoint()` — to prove the
//     focus and the pointer really are where the check claims they are, rather
//     than where the test believes them to be
//
// Each phase records its own failure and the run continues, so one pass shows
// every broken thing instead of only the first.

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

const failures = [];
let phase = "";

/** Runs one phase; a failure is recorded and the run goes on to the next one. */
async function check(name, fn) {
  phase = name;
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL  ${name}: ${error.message}`);
  }
}

/** What the bar looks like and what the element is doing, in one snapshot. */
const barState = () =>
  page.evaluate(() => {
    const bar = document.querySelector(".player-controls");
    const v = document.querySelector(".player-wrap video");
    if (!bar || !v) return null;
    const cs = getComputedStyle(bar);
    return {
      opacity: Number(cs.opacity),
      pointerEvents: cs.pointerEvents,
      hidden: bar.getAttribute("data-hidden"),
      paused: v.paused,
      currentTime: v.currentTime,
      duration: v.duration,
      fullscreen: !!document.fullscreenElement,
      resume: !!document.querySelector(".player-resume"),
      panel: !!document.querySelector(
        "[data-quality-menu], [data-speed-menu], [data-subtitle-menu], [data-shortcuts-panel]",
      ),
    };
  });

/** What is under a viewport point, and whether it belongs to the bar. */
const underPoint = (x, y) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      const bar = document.querySelector(".player-controls");
      return {
        tag: el ? el.tagName : null,
        cls: el ? String(el.className) : null,
        inBar: !!(el && bar && bar.contains(el)),
      };
    },
    [x, y],
  );

const videoTime = () =>
  page.evaluate(() => document.querySelector(".player-wrap video").currentTime);

/** Waits until the time readout agrees with the element, so a click that reads
 *  React state is not racing the state that React has not seen yet. */
const waitForReadout = (text) =>
  page.waitForFunction(
    (t) => (document.querySelector("[data-time]")?.textContent ?? "").includes(t),
    text,
    { timeout: 5000 },
  );

/** Waits until the seek/volume slider has the focus, for real key presses. */
const focusSlider = (selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.focus();
    return { tag: document.activeElement?.tagName, type: document.activeElement?.type };
  }, selector);

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".player-extras button:has-text('画质')", { timeout: 25000 });

  // The fixture is 12.1 s and the idle window is 3 s, so a hold of ten seconds
  // would otherwise run the video to its end — and a finished video shows the
  // controls whatever the pointer is doing, which would hide a real bug.
  await page.evaluate(() => {
    document.querySelector(".player-wrap video").loop = true;
  });

  // A real click: requestFullscreen needs a user gesture.
  await page.locator('.player-extras button[title*="全屏"]').click();
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector(".player-wrap")?.getAttribute("data-fullscreen") === "1",
    null,
    { timeout: 5000 },
  );
  await page.evaluate(() => document.querySelector(".player-wrap video").play());
  await page.waitForFunction(
    () => {
      const v = document.querySelector(".player-wrap video");
      return !v.paused && v.currentTime > 0.2;
    },
    null,
    { timeout: 15000 },
  );
  const opening = await barState();
  assert.ok(opening.duration > 11, `the fixture is too short to measure 10s steps: ${opening.duration}s`);
  console.log(
    `setup  fullscreen=${opening.fullscreen} playing=${!opening.paused} duration=${opening.duration.toFixed(1)}s`,
  );

  // -- 1. the pointer parked on the bar must not fade it ----------------------
  const seekBox = await page.locator(".player-seek").boundingBox();
  const hx = seekBox.x + seekBox.width / 2;
  const hy = seekBox.y + seekBox.height / 2;
  let at10 = null;

  await check("指针停在控制条上 10 秒，控制条仍可见", async () => {
    await page.mouse.move(hx, hy);
    await page.waitForTimeout(300);
    const parked = await underPoint(hx, hy);
    // Without this the whole phase could pass while measuring a point that is
    // not on the bar at all.
    assert.equal(
      parked.inBar,
      true,
      `the test's own pointer is not on the bar: elementFromPoint(${hx.toFixed(0)}, ${hy.toFixed(0)}) → <${parked.tag} class="${parked.cls}">`,
    );
    console.log(`  pointer parked at ${hx.toFixed(0)},${hy.toFixed(0)} → <${parked.tag} class="${parked.cls}"> inside the bar`);

    await page.waitForTimeout(10000);
    at10 = await barState();
    const still = await underPoint(hx, hy);
    console.log(
      `  after 10.0s: opacity=${at10.opacity} pointerEvents=${at10.pointerEvents} ` +
        `data-hidden=${at10.hidden} playing=${!at10.paused} currentTime=${at10.currentTime.toFixed(1)}s ` +
        `underThePointer=<${still.tag} class="${still.cls}">`,
    );
    // The four assertions that make "still visible" mean something: playing, in
    // fullscreen, nothing else pinning the bar open.
    assert.equal(at10.fullscreen, true, "fullscreen was lost, so the fade never applied");
    assert.equal(at10.paused, false, "the fixture stopped playing, so the idle window never applied");
    assert.equal(at10.resume, false, "a resume prompt was up, which pins the bar by itself");
    assert.equal(at10.panel, false, "a menu was open, which pins the bar by itself");
    assert.ok(
      at10.opacity > 0.95,
      `the control bar faded out while the pointer was parked on it (computed opacity ${at10.opacity})`,
    );
    assert.notEqual(
      at10.pointerEvents,
      "none",
      "the control bar stopped accepting clicks while the pointer was on it",
    );
    // Last, because when the bar has faded the pointer legitimately hit-tests
    // through it — that is the consequence, not a separate failure.
    assert.equal(
      still.inBar,
      true,
      "the bar is up but the pointer is not over it, so the hold proved nothing",
    );
  });

  // -- 2. …and it still goes away once the pointer leaves ---------------------
  // The half that keeps phase 1 honest: "never hides" would be a worse bug than
  // the one being fixed.
  const videoBox = await page.locator(".player-wrap video").boundingBox();
  const ox = videoBox.x + videoBox.width / 2;
  const oy = videoBox.y + videoBox.height * 0.3;

  await check("指针离开控制条与画面后，控制条在约 3 秒内消失", async () => {
    await page.mouse.move(ox, oy);
    // First bring the bar back (the move woke it) and let that transition land,
    // so the measurement below cannot catch the tail of the *previous* state.
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector(".player-controls")).opacity) > 0.95,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(250);
    // One more pixel, to start the idle countdown from a known instant. Still
    // over the picture, nowhere near the bar.
    const t0 = Date.now();
    await page.mouse.move(ox + 2, oy + 2);
    let hiddenAfter = null;
    for (let i = 0; i < 70; i++) {
      const s = await barState();
      if (s.opacity < 0.02) {
        hiddenAfter = (Date.now() - t0) / 1000;
        break;
      }
      await page.waitForTimeout(100);
    }
    const now = await barState();
    const away = await underPoint(ox, oy);
    console.log(
      `  pointer moved to ${ox.toFixed(0)},${oy.toFixed(0)} → <${away.tag} class="${away.cls}">; ` +
        `opacity=${now.opacity} pointerEvents=${now.pointerEvents} data-hidden=${now.hidden} ` +
        `after ${hiddenAfter === null ? ">7" : hiddenAfter.toFixed(2)}s`,
    );
    assert.equal(away.inBar, false, "the pointer did not actually leave the bar");
    assert.notEqual(hiddenAfter, null, "the controls never faded after the pointer left the bar");
    assert.ok(
      hiddenAfter >= 2.0 && hiddenAfter <= 4.2,
      `the controls faded after ${hiddenAfter.toFixed(2)}s instead of the 3s idle window`,
    );
    assert.ok(now.opacity < 0.02, `computed opacity is still ${now.opacity}`);
    assert.equal(now.pointerEvents, "none", "a faded bar is still swallowing clicks");
  });

  // -- 3. paused keeps them up ------------------------------------------------
  await check("暂停时控制条常显（既有行为不回归）", async () => {
    await page.evaluate(() => document.querySelector(".player-wrap video").pause());
    await page.mouse.move(ox, oy - 40);
    await page.waitForTimeout(4000);
    const s = await barState();
    console.log(`  paused, 4s after the last move: opacity=${s.opacity} pointerEvents=${s.pointerEvents}`);
    assert.equal(s.paused, true, "the video did not stay paused");
    assert.ok(s.opacity > 0.95, `pausing hid the controls (opacity ${s.opacity})`);
    assert.notEqual(s.pointerEvents, "none", "pausing made the controls unclickable");
  });

  // -- 4. an open panel keeps them up ----------------------------------------
  await check("菜单/面板打开时控制条常显（既有行为不回归）", async () => {
    await page.evaluate(() => document.querySelector(".player-wrap video").play());
    await page.waitForFunction(
      () => document.querySelector(".player-wrap video")?.paused === false,
      null,
      { timeout: 5000 },
    );
    await page.locator("[data-shortcuts-toggle]").click();
    await page.waitForSelector("[data-shortcuts-panel]", { timeout: 5000 });
    // Off the bar, so the only thing holding the bar up is the open panel.
    await page.mouse.move(ox, oy + 40);
    await page.waitForTimeout(4000);
    const s = await barState();
    console.log(
      `  with 键盘快捷键 open, 4s after the last move: opacity=${s.opacity} panel=${s.panel} playing=${!s.paused}`,
    );
    assert.equal(s.panel, true, "the panel closed on its own");
    assert.ok(s.opacity > 0.95, `an open panel let the controls fade (opacity ${s.opacity})`);
    await page.locator("[data-shortcuts-toggle]").click();
    await page.waitForFunction(() => !document.querySelector("[data-shortcuts-panel]"), null, {
      timeout: 5000,
    });
  });

  // -- 5. 快进 10 秒, symmetric with 后退 10 秒 --------------------------------
  await check("控制条有「快进 10 秒」按钮，点击后 currentTime 增加约 10 秒", async () => {
    await page.evaluate(() => document.querySelector(".player-wrap video").pause());
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector(".player-controls")).opacity) > 0.95,
      null,
      { timeout: 5000 },
    );

    const backCount = await page.locator("[data-seek-back]").count();
    const fwdCount = await page.locator("[data-seek-forward]").count();
    assert.equal(fwdCount, 1, `the bar has no 快进 10 秒 button (found ${fwdCount})`);
    assert.equal(backCount, 1, `expected one 后退 button, found ${backCount}`);
    const backTitle = (await page.getAttribute("[data-seek-back]", "title")) ?? "";
    const fwdTitle = (await page.getAttribute("[data-seek-forward]", "title")) ?? "";
    console.log(`  buttons: 后退 title="${backTitle}" / 快进 title="${fwdTitle}"`);
    assert.match(backTitle, /后退 10 秒/, "the existing 后退 button lost its label");
    assert.match(fwdTitle, /快进 10 秒/, "the 快进 button does not say what it does");

    await page.evaluate(() => {
      document.querySelector(".player-wrap video").currentTime = 1;
    });
    await waitForReadout("0:01 /");
    const before = await videoTime();
    await page.locator("[data-seek-forward]").click();
    await page.waitForTimeout(250);
    const after = await videoTime();
    console.log(`  快进 click: currentTime ${before.toFixed(2)} → ${after.toFixed(2)} (Δ ${(after - before).toFixed(2)}s)`);
    assert.ok(
      Math.abs(after - (before + 10)) < 0.6,
      `快进 moved the playhead by ${(after - before).toFixed(2)}s instead of ten`,
    );
  });

  // -- 6. arrow keys with the focus left on the seek slider -------------------
  await check("焦点在进度条上时，方向键仍然快进/快退 10 秒", async () => {
    await page.evaluate(() => document.querySelector(".player-wrap video").pause());
    const box = await page.locator(".player-seek").boundingBox();
    // A real drag, because that is what leaves the focus on the range for a
    // viewer — `focus()` alone would not prove the situation being fixed.
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName, type: el.type ?? null, cls: String(el.className) } : null;
    });
    console.log(`  after a drag, document.activeElement = <${focused?.tag} type="${focused?.type}" class="${focused?.cls}">`);
    assert.equal(focused?.tag, "INPUT", `the drag left the focus on <${focused?.tag}>`);
    assert.equal(focused?.type, "range", `the drag left the focus on a "${focused?.type}" input`);
    assert.match(focused?.cls ?? "", /player-seek/, "the drag left the focus somewhere else");

    await page.evaluate(() => {
      document.querySelector(".player-wrap video").currentTime = 1;
    });
    await waitForReadout("0:01 /");
    const beforeRight = await videoTime();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    const afterRight = await videoTime();
    const forwardBy = afterRight - beforeRight;
    console.log(`  → with the slider focused: currentTime ${beforeRight.toFixed(2)} → ${afterRight.toFixed(2)} (Δ ${forwardBy.toFixed(2)}s)`);
    assert.ok(
      Math.abs(afterRight - (beforeRight + 10)) < 0.6,
      `→ moved the playhead by ${forwardBy.toFixed(2)}s instead of ten (the slider kept the key)`,
    );

    const beforeLeft = await videoTime();
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(300);
    const afterLeft = await videoTime();
    const backBy = afterLeft - beforeLeft;
    console.log(`  ← with the slider focused: currentTime ${beforeLeft.toFixed(2)} → ${afterLeft.toFixed(2)} (Δ ${backBy.toFixed(2)}s)`);
    assert.ok(
      Math.abs(afterLeft - (beforeLeft - 10)) < 0.6,
      `← moved the playhead by ${backBy.toFixed(2)}s instead of ten (the slider kept the key)`,
    );
  });

  // Leave fullscreen: only elements inside the fullscreen element can be
  // focused, and the checks below need the page's own text box.
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });

  // -- 7. a text box still owns its arrow keys --------------------------------
  // The narrowing of "who is typing" must not have swallowed real text fields.
  await check("焦点在文本框里时，方向键不移动播放位置", async () => {
    await page.locator("[data-preview-note]").focus();
    const before = await videoTime();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    const after = await videoTime();
    const active = await page.evaluate(() => document.activeElement?.getAttribute("data-preview-note") ?? "");
    console.log(`  → with the note field focused: currentTime ${before.toFixed(2)} → ${after.toFixed(2)}`);
    assert.equal(active, "1", "the note field did not have the focus");
    assert.ok(
      Math.abs(after - before) < 0.01,
      `a key press in a text box seeked the video (${before} → ${after})`,
    );
  });

  // -- 8. the volume slider is a slider too ----------------------------------
  await check("焦点在音量条上时，↑ 按播放器的 5% 步进", async () => {
    await page.evaluate(() => {
      document.querySelector(".player-wrap video").volume = 0.5;
    });
    const focused = await focusSlider(".player-volume");
    console.log(`  focused <${focused.tag} type="${focused.type}">`);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    const vol = await page.evaluate(() => document.querySelector(".player-wrap video").volume);
    // 0.05 is the player's step; the slider's own step is 0.01, so this also
    // proves the native handling did not get a second say.
    console.log(`  ↑ with the volume slider focused: volume 0.50 → ${vol.toFixed(3)}`);
    assert.ok(Math.abs(vol - 0.55) < 0.005, `↑ moved the volume to ${vol} instead of 0.55`);
  });

  await page.screenshot({ path: path.join(outDir, "video-idle.png") });
  console.log("  screenshot: test-results/video-idle.png");
} catch (error) {
  failures.push(`${phase || "setup"}: ${error.message}`);
  console.error(`${phase || "setup"} threw:`, error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "video-idle-failure.png") });
    console.error("  failure screenshot: test-results/video-idle-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
} else {
  console.log("\nall checks passed");
}

process.exit(failures.length > 0 ? 1 : 0);
