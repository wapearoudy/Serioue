// "Every failure says what to do about it."
//
// The claim under test is narrow and specific: an app-level failure carries the
// one action that can undo it, and pressing it re-issues *that* request without
// disturbing anything else. A button that retries the whole app would pass a
// weaker test, so the counts are asserted on every command, not just the one
// that failed.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "test-results");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:1420/reader-app-error-preview.html";

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.READER_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const calls = () => page.evaluate(() => ({ ...(window.__calls ?? {}) }));
const stopFailing = () => page.evaluate(() => window.__fail?.clear());
const startFailing = (cmds) =>
  page.evaluate((list) => {
    window.__fail = new Set(list);
  }, cmds);
const bannerText = () =>
  page.locator(".main .banner, .banner").first().innerText().catch(() => "");
const retryButton = () => page.locator('[data-retry="app"]');

let failed = false;

try {
  // -- 1. a failure to load the source list offers exactly that retry ---------
  await page.goto(`${base}?fail=list_sources`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await retryButton().waitFor({ state: "visible", timeout: 15000 });
  const said = (await bannerText()).replace(/\s+/g, " ").trim();
  console.log(`  the banner says: "${said}"`);
  assert.match(said, /list_sources/, `the banner does not name what failed: ${said}`);
  assert.equal(await retryButton().innerText(), "重试", "the retry is not labelled as one");
  console.log("  a failed source list offers 「重试」");

  // Nothing may be hidden behind the banner: the close button is still there, so
  // a reader who does not want to retry can dismiss it.
  assert.equal(
    await page.locator('.banner button[aria-label="关闭"]').count(),
    1,
    "the error cannot be dismissed any more",
  );

  // -- 2. pressing it re-issues that request, and only that -------------------
  await stopFailing();
  const before = await calls();
  await retryButton().click();
  await page.waitForFunction(() => !document.querySelector('[data-retry="app"]'), null, {
    timeout: 10000,
  });
  await page.waitForSelector(".cat", { timeout: 10000 });
  const after = await calls();
  const delta = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[key] ?? 0) - (before[key] ?? 0);
    if (d) delta[key] = d;
  }
  console.log(`  after retry, calls that changed: ${JSON.stringify(delta)}`);

  assert.equal(delta.list_sources, 1, `the retry should re-issue the source list once: ${JSON.stringify(delta)}`);
  assert.equal(delta.stats, 1, `the source list comes with its stats, so those go too: ${JSON.stringify(delta)}`);
  // Reading preferences are loaded once at startup and already succeeded, so a
  // retry has no business re-reading them.
  assert.equal(delta.get_settings ?? 0, 0, `the retry re-read the settings: ${JSON.stringify(delta)}`);

  // `categories` and `load_page` moving here is **not** the retry re-running
  // work: the source list had never loaded, so no source was selected and neither
  // had run. They run now for the first time because the retry succeeded. What
  // matters is that they were at zero beforehand — had the retry been re-issuing
  // everything, they would not have been idle before it.
  assert.equal(before.categories ?? 0, 0, `categories had already run: ${JSON.stringify(before)}`);
  assert.equal(before.load_page ?? 0, 0, `the list had already loaded: ${JSON.stringify(before)}`);
  console.log("  the retry re-issued the source list and left everything else alone");

  // -- 3. the list really did come back ---------------------------------------
  await page.waitForSelector(".src-item", { timeout: 10000 });
  const sources = await page.locator(".src-item").count();
  assert.equal(sources, 2, `the sources did not come back: ${sources}`);
  console.log(`  and the ${sources} sources are there`);

  // -- 4. a second failure type carries its own retry, not a generic one ------
  await page.goto(`${base}?fail=stats`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await retryButton().waitFor({ state: "visible", timeout: 15000 });
  const second = (await bannerText()).replace(/\s+/g, " ").trim();
  console.log(`  with stats failing instead: "${second}"`);
  assert.match(second, /stats/, `the second failure names the wrong thing: ${second}`);

  await stopFailing();
  const before2 = await calls();
  await retryButton().click();
  await page.waitForFunction(() => !document.querySelector('[data-retry="app"]'), null, { timeout: 10000 });
  const after2 = await calls();
  assert.equal(
    (after2.stats ?? 0) - (before2.stats ?? 0),
    1,
    `the stats retry did not re-issue stats: ${JSON.stringify(after2)}`,
  );
  // Here the source list *did* load, so a source is selected and the category
  // and page fetches have already run. This is the case where "the retry did not
  // re-run anything else" is a real claim rather than an accident of ordering.
  assert.ok(
    (before2.categories ?? 0) > 0,
    `the category list should already have loaded: ${JSON.stringify(before2)}`,
  );
  assert.equal(
    (after2.categories ?? 0) - (before2.categories ?? 0),
    0,
    `the stats retry re-fetched categories: ${JSON.stringify(after2)}`,
  );
  assert.equal(
    (after2.load_page ?? 0) - (before2.load_page ?? 0),
    0,
    `the stats retry re-fetched the list: ${JSON.stringify(after2)}`,
  );
  assert.equal(
    (after2.get_settings ?? 0) - (before2.get_settings ?? 0),
    0,
    "the stats retry re-read the settings",
  );
  console.log("  and that one re-issued stats, again without touching the rest");

  await page.screenshot({ path: join(outDir, "reader-app-error.png") });
  console.log("  screenshot: test-results/reader-app-error.png");
} catch (e) {
  failed = true;
  console.log(`reader app error test failed: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(outDir, "reader-app-error-failure.png") }).catch(() => {});
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
