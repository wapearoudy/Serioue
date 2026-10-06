// Does the music player settle, or does it feed itself?
//
//   node scripts/music-stability-test.mjs
//
// Needs `pnpm dev` running.
//
// The worry is structural, not cosmetic. A parent that rebuilds `tracks={[…]}`
// inline hands the player a new array on every one of its renders; if the queue
// restore depends on that identity, the restore writes state, the persist effect
// writes storage on every state change, and the two can end up feeding each
// other — which is the shape that froze `ArticleList` into a 100% CPU loop.
//
// So this measures, rather than argues:
//   - storage writes per second while a parent re-renders 10×/second
//   - whether a queue edit the listener made survives those re-renders
//   - whether the page is still responsive (the loop's real symptom)
//   - and the same after switching source and back, which is where the
//     ArticleList freeze only showed up.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";

await mkdir(outDir, { recursive: true });

// Count every write to the stores the player uses. This is the quantity that
// goes unbounded in a feedback loop.
const init = `
  window.__writes = [];
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (String(key).startsWith("serious.music")) {
      window.__writes.push({ key: String(key), at: performance.now() });
    }
    return original.call(this, key, value);
  };
`;

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.MUSIC_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.addInitScript(init);
let failed = false;

const writes = () => page.evaluate(() => window.__writes.length);
const rows = () => page.locator(".music-queue li").count();

try {
  // `reader-nav-preview` passes an inline array; this page does the same thing
  // deliberately, and re-renders the parent on a timer like that harness does
  // when the user is clicking around it.
  await page.goto(`${url}?tracks=${encodeURIComponent(
    JSON.stringify([
      { url: "/demo/track-1.wav", title: "第一首", duration: 8 },
      { url: "/demo/track-2.wav", title: "第二首", duration: 2 },
      { url: "/demo/track-3.wav", title: "第三首" },
    ]),
  )}&rerender=1`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".music-queue li", { timeout: 15000 });

  // The page re-renders itself ten times a second (`?rerender=1`) and hands the
  // player a freshly built array each time.
  const renders = () =>
    page.evaluate(() => Number(document.querySelector(".main")?.getAttribute("data-rerenders") ?? 0));

  // Does the page hammer storage while the parent re-renders?
  const before = await writes();
  const rendersBefore = await renders();
  await page.waitForTimeout(3000);
  const after = await writes();
  const rendered = (await renders()) - rendersBefore;
  console.log(`  3 秒内：父组件渲染 ${rendered} 次，存储写入 ${after - before} 次`);
  assert.ok(rendered > 15, `the parent barely re-rendered (${rendered}), nothing was exercised`);
  assert.ok(
    after - before <= 2,
    `the player wrote its stores ${after - before} times in 3s of parent re-renders — that is a feedback loop`,
  );

  // The page must still answer.
  const responsive = await page.evaluate(() => {
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 200000; i++) n += i;
    return { ms: Math.round(performance.now() - t0), n: n > 0 };
  });
  console.log(`  主线程响应：200k 次循环 ${responsive.ms} ms`);
  assert.ok(responsive.n && responsive.ms < 500, `the main thread is busy (${responsive.ms} ms)`);

  // An edit the listener made must survive all of that.
  const before2 = await writes();
  await page.locator(".music-queue li").nth(1).hover();
  await page.locator(".music-queue li").nth(1).locator(".remove").click();
  await page.waitForFunction(() => document.querySelectorAll(".music-queue li").length === 2, null, {
    timeout: 5000,
  });
  await page.waitForTimeout(1500);
  const stillTwo = await rows();
  const writesAfterEdit = (await writes()) - before2;
  console.log(`  删掉一项后 1.5 秒内：仍是 ${stillTwo} 行，期间写入 ${writesAfterEdit} 次`);
  assert.equal(stillTwo, 2, "the listener's edit was undone by the parent's re-renders");
  assert.ok(writesAfterEdit <= 2, `still writing after the edit settled (${writesAfterEdit} writes)`);

  // And switching source away and back — the situation the ArticleList freeze
  // only showed up in. (Write counting cannot span a navigation: the counter is
  // installed by an init script and resets with the document, which is why this
  // part asserts the settled state rather than a write total.)
  await page.goto(
    `${url}?tracks=${encodeURIComponent(
      JSON.stringify([
        { url: "/demo/track-1.wav", title: "第一首", duration: 8 },
        { url: "/demo/track-2.wav", title: "第二首", duration: 2 },
      ]),
    )}`,
    { waitUntil: "domcontentloaded", timeout: 20000 },
  );
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
  const away = await rows();
  await page.goto(
    `${url}?tracks=${encodeURIComponent(
      JSON.stringify([
        { url: "/demo/track-1.wav", title: "第一首", duration: 8 },
        { url: "/demo/track-2.wav", title: "第二首", duration: 2 },
        { url: "/demo/track-3.wav", title: "第三首" },
      ]),
    )}&rerender=1`,
    { waitUntil: "domcontentloaded", timeout: 20000 },
  );
  await page.waitForSelector(".music-queue li", { timeout: 15000 });
  // Let it settle first: the count that matters is not "how many writes while
  // arriving" but "how many once it has arrived". A loop never reaches zero.
  await page.waitForTimeout(1500);
  const settledBaseline = await writes();
  await page.waitForTimeout(2000);
  const settled = await rows();
  const drift = (await writes()) - settledBaseline;
  console.log(
    `  切走时 ${away} 行；切回并稳定后再跑 2 秒：${settled} 行，这 2 秒内写入 ${drift} 次`,
  );
  // The track removed earlier stays removed whichever source we pass through:
  // that is the queue being remembered rather than re-seeded.
  assert.equal(settled, 1, "the removal was forgotten, or the queue was re-seeded from the page");
  assert.equal(drift, 0, `still writing ${drift} times once settled — that is a feedback loop`);

  const responsiveAgain = await page.evaluate(() => {
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 200000; i++) n += i;
    return { ms: Math.round(performance.now() - t0), n: n > 0 };
  });
  console.log(`  切回后主线程响应：200k 次循环 ${responsiveAgain.ms} ms`);
  assert.ok(
    responsiveAgain.n && responsiveAgain.ms < 500,
    `the page is busy after switching back (${responsiveAgain.ms} ms)`,
  );

  await page.screenshot({ path: path.join(outDir, "music-stability.png") });
  console.log("  screenshot: test-results/music-stability.png");
} catch (error) {
  failed = true;
  console.error("music stability test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "music-stability-failure.png") });
    console.error("  failure screenshot: test-results/music-stability-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);