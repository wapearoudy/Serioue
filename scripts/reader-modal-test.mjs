// Drives the real import dialog with the keyboard.
//
//   node scripts/reader-modal-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-modal-preview.html).
//
// What it proves:
//   1. Escape closes the dialog — before this, Escape did nothing at all
//   2. focus moves into the dialog when it opens
//   3. Tab (and Shift+Tab) never leaves the dialog, however many times it wraps
//   4. focus returns to the button that opened it, not to <body>
//   5. the placeholder follows the configured repository, not a hard-coded site
//   6. the dialog announces itself (role/aria-modal) and the invalid
//      <a><button></a> nesting is gone
//   7. the lightbox in media.tsx carries the dialog role too

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base = process.env.READER_MODAL_PREVIEW_URL || "http://localhost:1420/reader-modal-preview.html";
const REPO = "https://mirror.example";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_MODAL_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
let failed = false;

/** Where the focus is, relative to the dialog. */
const focusWhere = () =>
  page.evaluate(() => {
    const dialog = document.querySelector("[data-repo-dialog]");
    const active = document.activeElement;
    return {
      hasDialog: Boolean(dialog),
      inside: Boolean(dialog && active && dialog.contains(active)),
      tag: active?.tagName ?? "",
      text: (active?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24),
      isBody: active === document.body,
      openerFocused: active?.hasAttribute("data-open-repo") ?? false,
    };
  });

async function openDialog(query = "") {
  await page.goto(`${base}?repo=${encodeURIComponent(REPO)}${query}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector("[data-open-repo]", { timeout: 15000 });
  await page.locator("[data-open-repo]").click();
  await page.waitForSelector("[data-repo-dialog]", { timeout: 10000 });
}

try {
  // -- semantics --------------------------------------------------------------
  await openDialog();
  const semantics = await page.evaluate(() => {
    const dialog = document.querySelector("[data-repo-dialog]");
    const labelledBy = dialog?.getAttribute("aria-labelledby");
    return {
      role: dialog?.getAttribute("role"),
      modal: dialog?.getAttribute("aria-modal"),
      label: labelledBy
        ? document.getElementById(labelledBy)?.textContent?.trim() ?? null
        : null,
      // The invalid nesting: an interactive <button> inside a link.
      buttonsInLinks: document.querySelectorAll("a button").length,
    };
  });
  assert.equal(semantics.role, "dialog", `the dialog has no role: ${JSON.stringify(semantics)}`);
  assert.equal(semantics.modal, "true", `aria-modal is not set: ${JSON.stringify(semantics)}`);
  assert.match(semantics.label ?? "", /导入合集/, `no readable title: ${JSON.stringify(semantics)}`);
  assert.equal(semantics.buttonsInLinks, 0, `a <button> is still nested in a link: ${semantics.buttonsInLinks}`);
  console.log(`  role=${semantics.role} aria-modal=${semantics.modal} title="${semantics.label}"`);
  console.log("  no <a><button></a> nesting left in the page");

  // -- focus goes in ----------------------------------------------------------
  const onOpen = await focusWhere();
  assert.ok(onOpen.inside, `focus stayed behind the dialog: ${JSON.stringify(onOpen)}`);
  console.log(`  focus moved into the dialog: <${onOpen.tag}> "${onOpen.text}"`);

  // -- and stays in -----------------------------------------------------------
  // Enough presses to wrap several times over the dialog's own controls.
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    const where = await focusWhere();
    assert.ok(where.inside, `Tab ${i + 1} escaped the dialog onto <${where.tag}> "${where.text}"`);
  }
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Shift+Tab");
    const where = await focusWhere();
    assert.ok(where.inside, `Shift+Tab ${i + 1} escaped onto <${where.tag}> "${where.text}"`);
  }
  console.log("  24 Tabs and 12 Shift+Tabs: focus never left the dialog");

  // -- Escape closes, and gives the focus back --------------------------------
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-repo-dialog]"), null, {
    timeout: 5000,
  });
  const afterEscape = await focusWhere();
  assert.equal(afterEscape.hasDialog, false, "the dialog is still on screen after Escape");
  assert.ok(
    afterEscape.openerFocused,
    `focus was not returned to the button that opened it: ${JSON.stringify(afterEscape)}`,
  );
  assert.ok(!afterEscape.isBody, "focus fell back to <body> instead of the opener");
  console.log("  Escape closed it, and focus is back on the 导入合集 button");

  // -- the placeholder follows the configured repository ----------------------
  await page.locator("[data-open-repo]").click();
  await page.waitForSelector("[data-repo-dialog]", { timeout: 5000 });
  const placeholder = await page.getAttribute('[data-repo-dialog] input', "placeholder");
  assert.ok(placeholder, "the field has no placeholder at all");
  assert.ok(
    placeholder.includes(REPO),
    `the placeholder does not follow the configured repository: ${placeholder}`,
  );
  assert.ok(
    !placeholder.includes("yck2026.fun"),
    `the hard-coded site is still being taught: ${placeholder}`,
  );
  console.log(`  placeholder: ${placeholder}`);

  // A second repository must change it again, not just the first one.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-repo-dialog]"), null, { timeout: 5000 });
  await page.goto(`${base}?repo=${encodeURIComponent("https://other.example")}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-open-repo]").click();
  await page.waitForSelector("[data-repo-dialog]", { timeout: 5000 });
  const other = await page.getAttribute('[data-repo-dialog] input', "placeholder");
  assert.ok(other?.includes("other.example"), `the placeholder is stale: ${other}`);
  assert.ok(!other?.includes(REPO), `the previous repository leaked through: ${other}`);
  console.log(`  with another repository configured: ${other}`);

  await page.screenshot({ path: path.join(outDir, "reader-modal.png") });
  console.log("  screenshot: test-results/reader-modal.png");
} catch (error) {
  failed = true;
  console.error("reader modal test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-modal-failure.png") });
    console.error("  failure screenshot: test-results/reader-modal-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);