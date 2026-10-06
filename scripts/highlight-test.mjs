// Drives the real Reader's highlight flow: select text across inline tags,
// save it, and find it again on a fresh mount.
//
//   node scripts/highlight-test.mjs
//
// Needs `pnpm dev` running.
//
// What it proves:
//   - selecting a passage shows the 高亮 / 笔记 buttons
//   - the passage is stored and drawn back into the text
//   - a passage split across <strong> and <em> is matched, because the source
//     HTML has no text node containing it
//   - the mark survives a remount, which is what reopening the article does
//   - highlighting the same sentence again does not duplicate it
//   - a note can be attached, and the panel lists both
//   - deleting a highlight removes it from the page and the list

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url =
  process.env.HIGHLIGHT_PREVIEW_URL || "http://localhost:1420/highlight-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.HIGHLIGHT_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
let failed = false;

/**
 * Select `text` across the rendered text nodes, then fire the reader's handler.
 *
 * The needle deliberately spans an inline tag, so it never sits inside a single
 * text node — a per-node search would never find it, which is exactly the case
 * under test.
 */
async function selectText(page, text) {
  return page.evaluate((needle) => {
    const root = document.querySelector(".reader-rich");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
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

    // Build the concatenated text and a map back to (node, offset) so a match
    // spanning nodes can still be turned into a range.
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
    root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }, text);
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reader-rich", { timeout: 15000 });

  // -- nothing selected, no toolbar -----------------------------------------
  assert.equal(await page.locator(".mark-pop").count(), 0, "the toolbar appeared with no selection");
  console.log("  no toolbar until something is selected");

  // -- a selection that straddles two text nodes ----------------------------
  // "让人愿意一直读下去" is split by a <strong>, so no single text node holds it.
  const found = await selectText(page, "让人愿意一直读下去");
  assert.ok(found, "the test could not find its own fixture text");
  await page.waitForSelector(".mark-pop", { timeout: 5000 });
  const bar = (await page.locator(".mark-pop").innerText()).replace(/\s+/g, " ");
  assert.ok(/高亮/.test(bar) && /笔记/.test(bar), `unexpected toolbar: ${bar}`);
  console.log(`  toolbar after selecting a passage: ${bar}`);
  await page.screenshot({ path: path.join(outDir, "highlight-select.png") });

  await page.locator(".mark-pop button", { hasText: "高亮" }).click();

  // -- it is drawn into the text --------------------------------------------
  await page.waitForSelector(".reader-rich mark.reader-mark", { timeout: 5000 });
  const mark = (await page.locator(".reader-rich mark.reader-mark").first().innerText()).trim();
  assert.equal(mark, "让人愿意一直读下去", `the mark covers "${mark}"`);
  console.log(`  the passage is marked in the page: ${mark}`);

  // The text around it must not have been eaten by the wrapping. Checked across
// the whole article: the first paragraph alone does not contain the second.
  const article = (await page.locator(".reader-rich").innerText()).replace(/\s+/g, " ");
  assert.ok(article.includes("阅读器最难的不是把字显示出来"), `the article lost text: ${article}`);
  assert.ok(article.includes("行距、字号、版心宽度"), `the article lost text: ${article}`);
  assert.ok(article.includes("不用重新找位置"), `the article lost text: ${article}`);
  console.log(`  surrounding text intact across ${article.length} chars`);

  const stored = await page.evaluate(async () => {
    const raw = localStorage.getItem("serious-dev-store") ?? "{}";
    return JSON.parse(raw).highlights ?? [];
  });
  assert.equal(stored.length, 1, `${stored.length} highlights stored, expected 1`);
  console.log("  stored once");

  // -- a second passage, in a different paragraph ---------------------------
  await selectText(page, "换一台设备");
  await page.waitForSelector(".mark-pop", { timeout: 5000 });
  await page.locator(".mark-pop button", { hasText: "高亮" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".reader-rich mark.reader-mark").length === 2,
    null,
    { timeout: 5000 },
  );
  console.log("  a second passage highlights independently");

  // -- the same sentence again must not duplicate ---------------------------
  await selectText(page, "让人愿意一直读下去");
  await page.waitForSelector(".mark-pop", { timeout: 5000 });
  await page.locator(".mark-pop button", { hasText: "高亮" }).click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(async () => {
    const raw = localStorage.getItem("serious-dev-store") ?? "{}";
    return (JSON.parse(raw).highlights ?? []).length;
  });
  assert.equal(after, 2, `re-highlighting duplicated it (${after} rows)`);
  console.log("  re-highlighting the same sentence did not duplicate it");

  await page.screenshot({ path: path.join(outDir, "highlight-marked.png") });
  console.log("  screenshot: test-results/highlight-marked.png");

  // -- a note ---------------------------------------------------------------
  // The note is asked for in the in-app NoteDialog (window.prompt was removed
  // in t45): fill the textarea and save, instead of answering a system dialog.
  await selectText(page, "成组调整");
  await page.waitForSelector(".mark-pop", { timeout: 5000 });
  await page.locator(".mark-pop button", { hasText: "笔记" }).click();
  await page.waitForSelector("[data-note-dialog]", { timeout: 5000 });
  await page.locator("[data-note-input]").fill("这一段值得回头再看");
  await page.locator("[data-note-save]").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".reader-rich mark.reader-mark").length === 3,
    null,
    { timeout: 5000 },
  );

  // -- survives a remount ---------------------------------------------------
  // This is what reopening the article does: fresh DOM, highlights reloaded.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reader-rich", { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".reader-rich mark.reader-mark").length === 3,
    null,
    { timeout: 10000 },
  );
  const repainted = await page.locator(".reader-rich mark.reader-mark").allInnerTexts();
  console.log(`  after a reload the page shows ${repainted.length} marks: ${repainted.map((t) => t.trim()).join(" | ")}`);
  // Repainting must not nest marks inside marks.
  assert.equal(
    await page.locator(".reader-rich mark.reader-mark mark.reader-mark").count(),
    0,
    "marks nested inside each other after a repaint",
  );

  // -- the panel ------------------------------------------------------------
  await page.getByRole("button", { name: "打开划线列表" }).click();
  await page.waitForSelector(".mark-row", { timeout: 10000 });
  const rows = await page.locator(".mark-row").count();
  assert.equal(rows, 3, `the panel lists ${rows} rows, expected 3`);
  const note = await page.locator(".mark-note").first().innerText();
  assert.equal(note.trim(), "这一段值得回头再看", `note lost: ${note}`);
  console.log(`  panel lists ${rows} highlights, and the note reads "${note.trim()}"`);
  await page.screenshot({ path: path.join(outDir, "highlight-panel.png") });
  console.log("  screenshot: test-results/highlight-panel.png");

  // -- deleting -------------------------------------------------------------
  // Two steps now: the ✕ opens a confirmation, because a highlight can carry a
  // note the listener wrote themselves and there is no undo on the backend.
  await page.locator(".mark-row button[aria-label^='删除划线']").first().click();
  await page.waitForSelector("[data-delete-confirm]", { timeout: 5000 });
  const warning = (await page.locator("[data-delete-message]").innerText()).trim();
  assert.ok(warning.length > 0, "the confirmation says nothing about what is about to be lost");
  console.log(`  the delete asks first: "${warning}"`);
  await page.locator("[data-delete-yes]").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".mark-row").length === 2,
    null,
    { timeout: 5000 },
  );
  const left = await page.evaluate(async () => {
    const raw = localStorage.getItem("serious-dev-store") ?? "{}";
    return (JSON.parse(raw).highlights ?? []).length;
  });
  assert.equal(left, 2, `deleting left ${left} rows in the store`);
  console.log("  deleting a highlight removed it from the panel and the store");
} catch (error) {
  failed = true;
  console.error("highlight test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "highlight-failure.png") });
    console.error("  failure screenshot: test-results/highlight-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);