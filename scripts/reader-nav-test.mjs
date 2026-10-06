// Drives the real navigation surfaces with the keyboard only.
//
//   node scripts/reader-nav-test.mjs
//
// Needs `pnpm dev` running (it serves /reader-nav-preview.html).
//
// Every check here is: focus something with Tab, press Enter (or Space), and
// then assert that the *behaviour* changed — the harness records what each row
// was asked to do. Calling onClick directly would prove nothing about the tab
// order or the key handling, which is the whole subject.
//
// The ten sites from the audit, plus the two smaller fixes:
//   Sidebar 源列表项 / 继续阅读行 / 可用数量角标
//   ArticleList 文章卡片
//   HistoryPanel 历史行 + 清空历史的二次确认
//   ShelfPanel 书架行
//   HighlightsPanel 划线行
//   VerifyPanel 校验行 (Enter and Space both toggle, with aria-expanded)
//   Reader 章节目录 (needs the reader preview, checked separately)
//   MusicPlayer 播放队列项
//   Sidebar 继续阅读加载失败的那句轻提示

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const base = process.env.READER_NAV_PREVIEW_URL || "http://localhost:1420/reader-nav-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_NAV_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
let failed = false;

const probe = () => page.evaluate(() => window.__navProbe);

/**
 * Tab until the focus lands on the element matching `selector`.
 *
 * Asserting on `document.activeElement` is the point: a row that merely has an
 * onClick handler is skipped by Tab entirely, which is the defect being fixed.
 */
async function tabTo(selector, limit = 60) {
  for (let i = 0; i < limit; i++) {
    const here = await page.evaluate((sel) => {
      const el = document.activeElement;
      if (!el) return { ok: false, tag: "" };
      return {
        ok: el.matches(sel),
        tag: el.tagName,
        role: el.getAttribute("role"),
        tabIndex: el.getAttribute("tabindex"),
        label: el.getAttribute("aria-label"),
        outline: getComputedStyle(el).outlineStyle,
      };
    }, selector);
    if (here.ok) return here;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${selector}`);
}

/** Focus the first element on the page so Tab starts from a known place. */
async function resetFocus() {
  await page.evaluate(() => {
    if (document.activeElement) document.activeElement.blur();
    document.body.focus();
  });
}

try {
  // -- 1. Sidebar 源列表项：app 的主导航 ---------------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".src-item", { timeout: 15000 });

  const first = await tabTo('.src-item[aria-label^="甲源"]');
  assert.equal(first.role, "button", `the source row has no role: ${JSON.stringify(first)}`);
  assert.equal(first.tabIndex, "0");
  assert.notEqual(first.outline, "none", `the focused source row has no visible ring: ${first.outline}`);
  console.log(`  Tab lands on 甲源: role=${first.role} outline=${first.outline} label="${first.label}"`);

  // The most important assertion in this file: keyboard-only source switching.
  const before = (await probe()).selectedSource;
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.selectedSource !== null, null, { timeout: 5000 });
  let after = await probe();
  assert.equal(after.selectedSource, "src-a", `Enter did not select the source: ${JSON.stringify(after)}`);
  assert.notEqual(after.selectedSource, before, "the selected source did not change");
  console.log(`  Enter selected: ${after.selectedSource} (was ${before ?? "none"})`);

  // Space does the same on the next source.
  await resetFocus();
  await tabTo('.src-item[aria-label^="乙源"]');
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__navProbe.selectedSource === "src-b", null, { timeout: 5000 });
  console.log("  Space selected 乙源");

  // -- 2. Sidebar 继续阅读行 ---------------------------------------------------
  await resetFocus();
  const cont = await tabTo('.continue-row[aria-label^="继续阅读"]');
  assert.equal(cont.role, "button");
  console.log(`  continue row: "${cont.label}"`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.continued !== null, null, { timeout: 5000 });
  const afterCont = await probe();
  assert.equal(afterCont.continued, "https://demo.local/1", `Enter did not resume: ${JSON.stringify(afterCont)}`);
  console.log(`  Enter resumed: ${afterCont.continued}`);

  // -- 3. Sidebar 已检测源数量角标（原来是 <span> + cursor:pointer）------------
  await resetFocus();
  const badge = await tabTo("[data-sidebar-action='available']");
  assert.equal(badge.role, "button", `the availability badge is not a control: ${JSON.stringify(badge)}`);
  await page.keyboard.press("Enter");
  // It opens the verify panel; the preview switches views, so the panel heading
  // is the observable.
  await page.waitForSelector(".verify-row", { timeout: 5000 });
  console.log(`  availability badge: role=${badge.role} label="${badge.label}" → verify panel opened`);

  // -- 4. ArticleList 文章卡片 -------------------------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 15000 });
  await resetFocus();
  const card = await tabTo(".card[data-card='1']");
  assert.equal(card.role, "button");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.openedArticle !== null, null, { timeout: 5000 });
  const afterCard = await probe();
  assert.equal(afterCard.openedArticle, "第一篇", `Enter did not open the article: ${JSON.stringify(afterCard)}`);
  console.log(`  card: Enter opened "${afterCard.openedArticle}"`);

  // -- 5. HistoryPanel 历史行 + 清空确认 ----------------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "历史" }).click();
  await page.waitForSelector(".list .row", { timeout: 10000 });
  await resetFocus();
  const histRow = await tabTo(".list .row[role='button']");
  assert.match(histRow.label ?? "", /读过的第一篇/, `the history row has no useful label: ${histRow.label}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.openedHistory !== null, null, { timeout: 5000 });
  const afterHist = await probe();
  assert.equal(afterHist.openedHistory, "读过的第一篇", `Enter did not open the history row: ${JSON.stringify(afterHist)}`);
  console.log(`  history row: Enter opened "${afterHist.openedHistory}"`);

  // Clearing the history must ask first. Cancel keeps every row.
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.waitForTimeout(300);
  let p = await probe();
  assert.equal(p.clearedHistory, 0, "the history was cleared without a confirmation");
  const stillThere = await page.locator(".list .row").count();
  assert.equal(stillThere, 2, `cancelling lost rows: ${stillThere}`);
  console.log(`  清空 cancelled: 0 calls, ${stillThere} rows untouched`);

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.waitForFunction(() => window.__navProbe.clearedHistory > 0, null, { timeout: 5000 });
  p = await probe();
  assert.equal(p.clearedHistory, 1, `confirming did not clear it: ${JSON.stringify(p)}`);
  console.log(`  清空 confirmed: ${p.clearedHistory} call to clear_history`);

  // -- 6. ShelfPanel 书架行 ---------------------------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /书架/ }).first().click();
  await page.waitForSelector(".list .row", { timeout: 10000 });
  await resetFocus();
  const shelfRow = await tabTo(".list .row[role='button']");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.openedShelf !== null, null, { timeout: 5000 });
  const afterShelf = await probe();
  assert.ok(afterShelf.openedShelf, `Enter did not open the shelf row: ${JSON.stringify(afterShelf)}`);
  console.log(`  shelf row: Enter opened "${afterShelf.openedShelf}" (label "${shelfRow.label}")`);

  // -- 7. HighlightsPanel 划线行 ----------------------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /划线/ }).first().click();
  await page.waitForSelector(".mark-row", { timeout: 10000 });
  await resetFocus();
  const markRow = await tabTo(".mark-row-main[role='button']");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.openedMark !== null, null, { timeout: 5000 });
  const afterMark = await probe();
  assert.equal(afterMark.openedMark, "h1", `Enter did not open the highlight: ${JSON.stringify(afterMark)}`);
  console.log(`  highlight row: Enter opened h1 (label "${markRow.label}")`);

  // -- 8. VerifyPanel 校验行：Enter 与 Space 都要能展开，aria-expanded 要变 -----
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "校验" }).first().click();
  await page.waitForSelector(".verify-row", { timeout: 10000 });
  await resetFocus();
  const vrow = await tabTo(".verify-row[role='button']");
  const expandedBefore = await page.getAttribute(".verify-row", "aria-expanded");
  assert.equal(expandedBefore, "false", `aria-expanded is not reported: ${expandedBefore}`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".verify-detail", { timeout: 5000 });
  const expandedAfter = await page.getAttribute(".verify-row", "aria-expanded");
  assert.equal(expandedAfter, "true", `Enter did not report the expansion: ${expandedAfter}`);
  console.log(`  verify row: Enter expanded it, aria-expanded ${expandedBefore} -> ${expandedAfter}`);
  console.log(`  verify row label: "${vrow.label}"`);

  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => document.querySelector(".verify-row")?.getAttribute("aria-expanded") === "false",
    null,
    { timeout: 5000 },
  );
  assert.equal(await page.locator(".verify-detail").count(), 0, "Space did not collapse it");
  console.log("  Space collapsed it again");

  // -- 9. MusicPlayer 播放队列项 ------------------------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("[data-nav-view='music']").click();
  await page.waitForSelector(".music-queue li", { timeout: 10000 });
  await resetFocus();
  const qrow = await tabTo(".music-queue li[role='button']");
  assert.match(qrow.label ?? "", /第 \d+ 首/, `the queue row has no useful label: ${qrow.label}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.queueIndex !== null, null, { timeout: 5000 });
  const afterQueue = await probe();
  assert.equal(afterQueue.queueIndex, 0, `Enter did not pick the track: ${JSON.stringify(afterQueue)}`);
  console.log(`  queue row: Enter picked track ${afterQueue.queueIndex} (label "${qrow.label}")`);

  await page.screenshot({ path: path.join(outDir, "reader-nav.png") });
  console.log("  screenshot: test-results/reader-nav.png");

  // -- 10. Reader 章节目录：跳章只能靠鼠标的那一处 ------------------------------
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("[data-nav-view='reader']").click();
  await page.waitForSelector(".reader-body", { timeout: 10000 });
  await page.getByRole("button", { name: "目录", exact: true }).click();
  await page.waitForSelector(".toc-list li", { timeout: 5000 });
  await resetFocus();
  const tocRow = await tabTo(".toc-list li[aria-label^='第 3 章']");
  assert.equal(tocRow.role, "button", `the chapter entry has no role: ${JSON.stringify(tocRow)}`);
  assert.notEqual(tocRow.outline, "none", `the focused chapter entry has no visible ring: ${tocRow.outline}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__navProbe.sibling !== null, null, { timeout: 5000 });
  const afterToc = await probe();
  assert.equal(afterToc.sibling, "第三章 收束", `Enter did not jump the chapter: ${JSON.stringify(afterToc)}`);
  // Jumping closes the contents, which is what a reader expects after a jump.
  assert.equal(
    await page.locator(".toc-list").count(),
    0,
    "the contents stayed open after the jump",
  );
  console.log(`  chapter list: Tab → Enter jumped to "${afterToc.sibling}", contents closed`);
  console.log(`  chapter label: "${tocRow.label}"`);

  // -- 11. 继续阅读加载失败的轻提示 ---------------------------------------------
  await page.goto(`${base}?failContinue=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-sidebar-note='continue-failed']", { timeout: 10000 });
  const note = (await page.locator("[data-sidebar-note='continue-failed']").innerText()).trim();
  assert.match(note, /进度没有丢/, `the hint does not say the progress is safe: ${note}`);
  // A hint, not an error: it must not be styled like one, and the app still works.
  assert.equal(await page.locator(".continue-row").count(), 0, "the shelf rendered despite failing");
  const srcItems = await page.locator(".src-item").count();
  assert.equal(srcItems, 3, `the sidebar broke when the shelf failed: ${srcItems}`);
  console.log(`  继续阅读 failure: "${note}"`);
  console.log("  and the sidebar is otherwise untouched (3 sources listed)");
} catch (error) {
  failed = true;
  console.error("reader nav test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-nav-failure.png") });
    console.error("  failure screenshot: test-results/reader-nav-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);