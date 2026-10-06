// Drives the real SettingsPanel in a real browser.
//
//   node scripts/reader-settings-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-settings-preview.html).
//
// What it proves, each with an observable value:
//   1. 保存失败会回滚 —— the field returns to the value that is actually stored,
//      and the notice says so. Before the fix the screen kept the unsaved value
//      and reverted only on the next launch.
//   2. 保存成功有反馈，而且会自动消失
//
// `window.__settingsProbe.stored` is what the harness actually kept, which is
// how "the screen agrees with the disk" is checked rather than assumed.
//
// Note: the old "每页条数" number field was removed (t38): one list page holds
// whatever the upstream site or API puts on it, so the engine cannot honour a
// page-size setting — keeping the field meant keeping a switch that lies. The
// rollback/note behaviour below is exercised through the repository address
// field instead, which saves on blur like the number field used to.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base =
  process.env.READER_SETTINGS_PREVIEW_URL ||
  "http://localhost:1420/reader-settings-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_SETTINGS_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
let failed = false;

const probe = () => page.evaluate(() => window.__settingsProbe);
const repoBase = () => page.inputValue('[data-settings-field="repo_base"]');

async function open(query = "") {
  await page.goto(`${base}${query}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector('[data-settings-field="repo_base"]', { timeout: 15000 });
}

try {
  // -- 1. 保存失败必须回滚 ----------------------------------------------------
  await open("?failSave=1&slow=250");
  const before = await probe();
  const storedBefore = before.stored.repo_base;
  assert.equal(
    storedBefore,
    "https://www.yck2026.fun",
    `unexpected starting value: ${storedBefore}`,
  );

  // The repository address saves on blur, like the removed number field did.
  // Waiting on the field returning to what is stored is the observable that
  // matters — the notice text carries the reason, not the address.
  await page.fill('[data-settings-field="repo_base"]', "https://broken.example");
  await page.locator('[data-settings-field="repo_base"]').blur();
  await page.waitForSelector("[data-settings-error='1']", { timeout: 10000 });

  const failedText = (await page.locator("[data-settings-error='1']").innerText()).replace(/\s+/g, " ").trim();
  assert.match(failedText, /保存失败，已恢复原值/, `the failure does not say it rolled back: ${failedText}`);
  console.log(`  failure notice: ${failedText}`);

  await page.waitForFunction(
    (want) => document.querySelector('[data-settings-field="repo_base"]')?.value === want,
    before.stored.repo_base,
    { timeout: 8000 },
  );
  const repoAfter = await repoBase();
  assert.notEqual(repoAfter, "https://broken.example", `the failed address stayed on screen: ${repoAfter}`);
  const repoProbe = await probe();
  assert.equal(repoProbe.stored.repo_base, before.stored.repo_base, "a failed address reached the disk");
  assert.equal(repoProbe.failures, 1, `expected exactly one failed write: ${repoProbe.failures}`);
  console.log(`  repo address rolled back: "${repoAfter}"`);

  // -- 2. 保存成功有反馈，且会自动消失 ------------------------------------------
  await open();
  await page.fill('[data-settings-field="repo_base"]', "https://example.com/repo");
  await page.locator('[data-settings-field="repo_base"]').blur();
  await page.waitForSelector("[data-settings-note='1']", { timeout: 10000 });
  const note = (await page.locator("[data-settings-note='1']").innerText()).replace(/\s+/g, " ").trim();
  assert.match(note, /已保存/, `no success confirmation: ${note}`);
  console.log(`  success note: ${note}`);

  // And it must not stay on screen for good.
  await page.waitForFunction(() => !document.querySelector("[data-settings-note='1']"), null, {
    timeout: 8000,
  });
  const storedNow = (await probe()).stored.repo_base;
  assert.equal(storedNow, "https://example.com/repo", `the write did not reach the harness: ${storedNow}`);
  console.log(`  the note disappeared on its own; stored repo_base=${storedNow}`);

  await page.screenshot({ path: path.join(outDir, "reader-settings.png") });
  console.log("  screenshot: test-results/reader-settings.png");
} catch (error) {
  failed = true;
  console.error("reader settings test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-settings-failure.png") });
    console.error("  failure screenshot: test-results/reader-settings-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
