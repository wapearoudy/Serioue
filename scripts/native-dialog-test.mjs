// The last two system dialogs in the app: a note prompt that hides the quoted
// passage (and drops the draft when saving fails) and a favorite alert that
// offers no retry.
//
//   node scripts/native-dialog-test.mjs
//
// Needs `pnpm dev` running (it serves /highlight-preview.html and
// /reader-nav-preview.html).
//
// What it proves, against the real components (never recreated markup):
//   A. clicking 笔记 opens no system prompt — an in-app editor appears instead
//   B. the editor shows the quoted passage, is a real multiline textarea, and
//      lives inside the app (selector + computed style are reported)
//   C. focus moves into the editor on open; Escape closes it and focus returns
//      to the 笔记 trigger — all with real key presses, never .focus() alone
//   D. a failed save keeps the draft in the box (then a retry really saves it)
//   E. a failed favorite shows an inline error with a retry that re-issues
//      update_source (the call count is the proof, not the button label)
//   F. no window.prompt / window.alert remains anywhere under src/
//
// Pre-fix this script fails: A sees a prompt dialog, B/C/D find no editor, E
// sees an alert, F lists the two call sites. That failure output is the point.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const HIGHLIGHT_URL =
  process.env.NATIVE_DIALOG_HIGHLIGHT_URL || "http://localhost:1420/highlight-preview.html";
const NAV_URL = process.env.NATIVE_DIALOG_NAV_URL || "http://localhost:1420/reader-nav-preview.html";
const NEEDLE = "让人愿意一直读下去";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.NATIVE_DIALOG_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

/** System dialogs that appeared during a leg (type + message). */
let sysDialogs = [];
page.on("dialog", async (d) => {
  sysDialogs.push({ type: d.type(), message: d.message().slice(0, 80) });
  await d.dismiss();
});

/**
 * Select `text` across the rendered text nodes, then fire the reader's handler.
 * Same trick as highlight-test.mjs: the needle spans an inline tag, so it never
 * sits inside a single text node.
 */
async function selectText(text) {
  return page.evaluate((needle) => {
    const rootEl = document.querySelector(".reader-rich");
    if (!rootEl) return false;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName;
        return tag === "SCRIPT" || tag === "STYLE"
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n = walker.nextNode();
    while (n) {
      nodes.push(n);
      n = walker.nextNode();
    }
    let flat = "";
    const map = [];
    for (const node of nodes) {
      for (let k = 0; k < (node.nodeValue ?? "").length; k++) {
        map.push({ node, at: k });
        flat += (node.nodeValue ?? "")[k];
      }
    }
    const at = flat.indexOf(needle);
    if (at < 0) return false;
    const start = map[at];
    const end = map[at + needle.length - 1];
    const range = document.createRange();
    range.setStart(start.node, start.at);
    range.setEnd(end.node, end.at + 1);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    rootEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }, text);
}

async function leg(name, fn) {
  sysDialogs = [];
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed = true;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

try {
  console.log(`  highlight: ${HIGHLIGHT_URL}`);
  await page.goto(HIGHLIGHT_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reader-rich", { timeout: 15000 });

  // -- A. no system prompt ----------------------------------------------------
  await leg("A: clicking 笔记 opens an in-app editor, not window.prompt", async () => {
    assert.ok(await selectText(NEEDLE), "the test could not find its own fixture text");
    await page.waitForSelector(".mark-pop", { timeout: 5000 });
    await page.locator(".mark-pop button", { hasText: "笔记" }).click();
    await page.waitForTimeout(800);
    assert.equal(
      sysDialogs.length,
      0,
      `a system dialog appeared: ${JSON.stringify(sysDialogs)} (window.prompt still in use)`,
    );
    await page.waitForSelector("[data-note-dialog]", { timeout: 4000 });
    console.log("    no system dialog; [data-note-dialog] is on screen");
  });

  // -- B. quote + multiline + in-app appearance --------------------------------
  await leg("B: the editor shows the quoted passage and is multiline", async () => {
    const quote = await page.locator("[data-note-quote]").innerText({ timeout: 4000 });
    assert.ok(
      quote.replace(/\s+/g, "").includes(NEEDLE.replace(/\s+/g, "")),
      `the quoted passage is not the selection: "${quote.trim().slice(0, 60)}"`,
    );
    console.log(`    quote reads: "${quote.trim().slice(0, 40)}…"`);
    const tag = await page.locator("[data-note-input]").evaluate((el) => el.tagName);
    assert.equal(tag, "TEXTAREA", `the note box is a <${tag}>, not a multiline field`);
    const style = await page.locator("[data-note-dialog]").evaluate((el) => {
      const c = getComputedStyle(el);
      return { position: c.position, display: c.display, background: c.backgroundColor, radius: c.borderRadius };
    });
    assert.equal(style.position, "fixed", `the editor is not app-positioned: ${JSON.stringify(style)}`);
    console.log(`    computed: position=${style.position} display=${style.display} background=${style.background} radius=${style.radius}`);
    await page.screenshot({ path: path.join(outDir, "native-dialog-note.png") });
    console.log("    screenshot: test-results/native-dialog-note.png");
  });

  // -- C. real focus in, real Escape out, focus back on the trigger ------------
  await leg("C: focus enters the box, Escape closes, focus returns to 笔记", async () => {
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
    assert.equal(focused, "TEXTAREA", `opening did not move focus into the box (on <${focused}>)`);
    console.log("    focus is inside the textarea after opening");
    await page.locator("[data-note-input]").press("Enter");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-note-dialog]"), null, { timeout: 4000 });
    await page.waitForFunction(
      () => document.activeElement?.hasAttribute?.("data-note-trigger") ?? false,
      null,
      { timeout: 4000 },
    );
    const backOn = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? "",
    );
    assert.equal(backOn, "笔记", `focus came back to "${backOn}", not the trigger`);
    console.log('    Escape closed it and focus is back on "笔记"');
  });

  // -- D. a failed save keeps the draft, a retry really saves -------------------
  await leg("D: failed save keeps the draft; retry stores it", async () => {
    assert.ok(await selectText("成组调整"), "could not select the second passage");
    await page.waitForSelector(".mark-pop", { timeout: 5000 });
    await page.evaluate(() => {
      const inner = window.__TAURI_INTERNALS__.invoke;
      if (inner.__nativeDialogTest) return;
      const state = { addHighlightCalls: 0, failOnce: false };
      const wrapper = async (cmd, args = {}) => {
        if (cmd === "add_highlight") {
          state.addHighlightCalls += 1;
          if (state.failOnce) {
            state.failOnce = false;
            throw new Error("保存失败（测试注入）");
          }
        }
        return inner(cmd, args);
      };
      wrapper.__nativeDialogTest = true;
      window.__TAURI_INTERNALS__.invoke = wrapper;
      window.__nativeDialogCalls = state;
    });
    await page.locator(".mark-pop button", { hasText: "笔记" }).click();
    await page.waitForSelector("[data-note-dialog]", { timeout: 5000 });
    await page.evaluate(() => {
      window.__nativeDialogCalls.failOnce = true;
    });
    await page.locator("[data-note-input]").fill("草稿不能丢");
    await page.locator("[data-note-save]").click();
    await page.waitForSelector("[data-note-error]", { timeout: 5000 });
    const kept = await page.locator("[data-note-input]").inputValue();
    assert.equal(kept, "草稿不能丢", `the failed save ate the draft (box holds "${kept}")`);
    assert.equal(sysDialogs.length, 0, `a system dialog appeared: ${JSON.stringify(sysDialogs)}`);
    console.log('    after the injected failure the box still holds "草稿不能丢"');
    await page.locator("[data-note-save]").click();
    await page.waitForFunction(() => !document.querySelector("[data-note-dialog]"), null, { timeout: 5000 });
    const calls = await page.evaluate(() => window.__nativeDialogCalls.addHighlightCalls);
    assert.equal(calls, 2, `expected 2 add_highlight calls (fail + retry), saw ${calls}`);
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem("serious-dev-store") ?? "{}";
      return JSON.parse(raw).highlights ?? [];
    });
    const saved = stored.find((h) => h.note === "草稿不能丢");
    assert.ok(saved, `the retried note never reached the store (${stored.length} rows)`);
    console.log(`    retry saved it: 2 add_highlight calls, store holds the note on "${saved.text.slice(0, 20)}…"`);
  });

  // -- E. favorite failure: inline error + a retry that re-issues the request ---
  console.log(`  nav: ${NAV_URL}`);
  await leg("E: favorite failure is inline with a retry that re-sends update_source", async () => {
    await page.goto(NAV_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector(".src-item .star", { timeout: 15000 });
    await page.evaluate(() => {
      const inner = window.__TAURI_INTERNALS__.invoke;
      if (inner.__favTest) return;
      const state = { updateSourceCalls: 0, failOnce: true };
      const wrapper = async (cmd, args = {}) => {
        if (cmd === "update_source") {
          state.updateSourceCalls += 1;
          if (state.failOnce) {
            state.failOnce = false;
            throw new Error("收藏失败（测试注入）");
          }
          return null;
        }
        return inner(cmd, args);
      };
      wrapper.__favTest = true;
      window.__TAURI_INTERNALS__.invoke = wrapper;
      window.__favCalls = state;
    });
    await page.locator(".src-item .star").first().click();
    await page.waitForTimeout(800);
    assert.equal(
      sysDialogs.length,
      0,
      `a system dialog appeared: ${JSON.stringify(sysDialogs)} (window.alert still in use)`,
    );
    await page.waitForSelector("[data-fav-error]", { timeout: 5000 });
    const errText = (await page.locator("[data-fav-error]").innerText()).replace(/\s+/g, " ").trim();
    assert.ok(errText.length > 0, "the inline error says nothing");
    console.log(`    inline error reads: "${errText.slice(0, 60)}"`);
    await page.locator("[data-fav-retry]").click();
    await page.waitForFunction(() => !document.querySelector("[data-fav-error]"), null, { timeout: 5000 });
    const calls = await page.evaluate(() => window.__favCalls.updateSourceCalls);
    assert.equal(calls, 2, `the retry never re-sent the request (update_source called ${calls}x)`);
    console.log(`    retry re-sent update_source (${calls} calls total) and the error cleared`);
    await page.screenshot({ path: path.join(outDir, "native-dialog-sidebar.png") });
    console.log("    screenshot: test-results/native-dialog-sidebar.png");
  });

  // -- F. no window.prompt / window.alert left under src/ -------------------------
  await leg("F: no window.prompt / window.alert remains under src/", async () => {
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(full, "utf8");
          text.split("\n").forEach((line, i) => {
            if (/window\.(prompt|alert)\s*\(/.test(line)) {
              hits.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 70)}`);
            }
          });
        }
      }
    };
    walk(path.join(root, "src"));
    assert.equal(hits.length, 0, `system dialogs remain:\n    ${hits.join("\n    ")}`);
    console.log("    grep over src/**/*.ts(x): 0 hits");
  });
} catch (error) {
  failed = true;
  console.error("native dialog test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "native-dialog-failure.png") });
    console.error("  failure screenshot: test-results/native-dialog-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
