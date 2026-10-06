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
//   3. 数字框可以清空重输 —— select-all + Delete leaves the box empty instead
//      of snapping back to 60
//   4. 范围校验 —— 9999 is refused with an explanation, and what was stored is
//      still the old number rather than 9999 or a silently substituted one
//
// `window.__settingsProbe.stored` is what the harness actually kept, which is
// how "the screen agrees with the disk" is checked rather than assumed.

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
const pageSize = () => page.inputValue('[data-settings-field="page_size"]');
const repoBase = () => page.inputValue('[data-settings-field="repo_base"]');

async function open(query = "") {
  await page.goto(`${base}${query}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector('[data-settings-field="page_size"]', { timeout: 15000 });
}

try {
  // -- 1. 保存失败必须回滚 ----------------------------------------------------
  await open("?failSave=1&slow=250");
  const before = await probe();
  const storedBefore = before.stored.page_size;
  assert.equal(storedBefore, 60, `unexpected starting value: ${storedBefore}`);

  await page.click('[data-settings-field="page_size"]');
  await page.fill('[data-settings-field="page_size"]', "120");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForSelector("[data-settings-error='1']", { timeout: 10000 });

  const failedText = (await page.locator("[data-settings-error='1']").innerText()).replace(/\s+/g, " ").trim();
  assert.match(failedText, /保存失败，已恢复原值/, `the failure does not say it rolled back: ${failedText}`);
  console.log(`  failure notice: ${failedText}`);

  const afterField = await pageSize();
  assert.equal(
    afterField,
    String(storedBefore),
    `the screen still shows the unsaved value (${afterField}, stored is ${storedBefore})`,
  );
  const afterProbe = await probe();
  assert.equal(afterProbe.stored.page_size, storedBefore, "the harness stored the failed value");
  assert.equal(afterProbe.failures, 1, `expected exactly one failed write: ${afterProbe.failures}`);
  console.log(`  rolled back: field shows ${afterField}, disk still has ${afterProbe.stored.page_size}`);

  // The same must hold for the repository address, which saves on blur. Waiting
  // on the field returning to what is stored is the observable that matters —
  // the notice text carries the reason, not the address.
  await page.fill('[data-settings-field="repo_base"]', "https://broken.example");
  await page.locator('[data-settings-field="repo_base"]').blur();
  await page.waitForFunction(
    (want) => document.querySelector('[data-settings-field="repo_base"]')?.value === want,
    before.stored.repo_base,
    { timeout: 8000 },
  );
  const repoAfter = await repoBase();
  assert.notEqual(repoAfter, "https://broken.example", `the failed address stayed on screen: ${repoAfter}`);
  const repoProbe = await probe();
  assert.equal(repoProbe.stored.repo_base, before.stored.repo_base, "a failed address reached the disk");
  console.log(`  repo address rolled back: "${repoAfter}"`);

  // -- 2. 保存成功有反馈，且会自动消失 ------------------------------------------
  await open();
  await page.click('[data-settings-field="page_size"]');
  await page.fill('[data-settings-field="page_size"]', "80");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForSelector("[data-settings-note='1']", { timeout: 10000 });
  const note = (await page.locator("[data-settings-note='1']").innerText()).replace(/\s+/g, " ").trim();
  assert.match(note, /已保存/, `no success confirmation: ${note}`);
  console.log(`  success note: ${note}`);

  // And it must not stay on screen for good.
  await page.waitForFunction(() => !document.querySelector("[data-settings-note='1']"), null, {
    timeout: 8000,
  });
  const storedNow = (await probe()).stored.page_size;
  assert.equal(storedNow, 80, `the write did not reach the harness: ${storedNow}`);
  console.log(`  the note disappeared on its own; disk has page_size=${storedNow}`);

  // -- 3. 数字框可以清空重输 ----------------------------------------------------
  // Before the fix, `Number("") || 60` snapped the box back to 60 mid-edit.
  await page.click('[data-settings-field="page_size"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  const emptied = await pageSize();
  assert.equal(emptied, "", `the box refused to be emptied (shows "${emptied}")`);
  await page.keyboard.type("42");
  assert.equal(await pageSize(), "42", "typing after clearing did not work");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForFunction(() => !document.querySelector("[data-settings-note='1']") || true, null, {
    timeout: 2000,
  });
  await page.waitForTimeout(400);
  assert.equal((await probe()).stored.page_size, 42, `42 was not stored: ${(await probe()).stored.page_size}`);
  console.log(`  cleared and retyped 42; stored=${(await probe()).stored.page_size}`);

  // -- 4. 范围校验 -------------------------------------------------------------
  await page.click('[data-settings-field="page_size"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.type("9999");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForSelector("[data-settings-field-error='page_size']", { timeout: 5000 });
  const rangeText = (await page.locator("[data-settings-field-error='page_size']").innerText()).trim();
  assert.match(rangeText, /10 到 300/, `the range is not explained: ${rangeText}`);
  assert.match(rangeText, /9999/, `the refused value is not named: ${rangeText}`);
  const rangeProbe = await probe();
  assert.equal(rangeProbe.stored.page_size, 42, `9999 was stored anyway: ${rangeProbe.stored.page_size}`);
  assert.equal(await pageSize(), "42", `the field did not go back to the stored value: ${await pageSize()}`);
  console.log(`  range: "${rangeText}"`);
  console.log(`  stored value stayed ${rangeProbe.stored.page_size}, field shows ${await pageSize()}`);

  // An empty field is refused too, and is not turned into 60 behind the user's back.
  await page.click('[data-settings-field="page_size"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForSelector("[data-settings-field-error='page_size']", { timeout: 5000 });
  const emptyText = (await page.locator("[data-settings-field-error='page_size']").innerText()).trim();
  assert.match(emptyText, /整数/, `an empty field was not explained: ${emptyText}`);
  assert.equal((await probe()).stored.page_size, 42, "an empty field reached the disk");
  console.log(`  empty field: "${emptyText}"`);

  // The case that used to slip through: the panel accepted 400 (inside its own
  // 10-500 range) while the backend clamps at 300, so the value the user typed
  // was never the value that took effect. The panel now shares the backend's
  // range, and 400 has to be refused here — if the two drift apart again, this
  // turns red rather than relying on someone remembering.
  await page.click('[data-settings-field="page_size"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.type("400");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForSelector("[data-settings-field-error='page_size']", { timeout: 5000 });
  const overText = (await page.locator("[data-settings-field-error='page_size']").innerText()).trim();
  assert.match(overText, /10 到 300/, `the range does not match the backend: ${overText}`);
  assert.match(overText, /400/, `the refused value is not named: ${overText}`);
  assert.equal((await probe()).stored.page_size, 42, "400 reached the disk");
  assert.equal(await pageSize(), "42", `the field did not go back: ${await pageSize()}`);
  console.log(`  backend range: "${overText}"`);

  // And 300 itself — the backend's own ceiling — must still be accepted.
  await page.click('[data-settings-field="page_size"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.type("300");
  await page.locator('[data-settings-field="page_size"]').blur();
  await page.waitForSelector("[data-settings-note='1']", { timeout: 8000 });
  assert.equal((await probe()).stored.page_size, 300, "the boundary value was refused");
  console.log("  300 (the backend's own ceiling) is still accepted and stored");

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