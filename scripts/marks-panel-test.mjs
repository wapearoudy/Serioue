// The highlights panel: notes can be written, and deleting one warns first.
//
//   node scripts/marks-panel-test.mjs
//
// Needs `pnpm dev` running.
//
// The highlights are seeded into the dev stub's store (the same one the real
// backend reads), so what is asserted is the panel driving real persistence: a
// note that has just been saved is read back out of the store, not out of the
// component's own state, which is the difference between "the button worked" and
// "the words were kept".

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url = process.env.HIGHLIGHT_PREVIEW_URL || "http://localhost:1420/highlight-preview.html";

/** Three highlights: one with a note, one without, one whose note is a keyword. */
const SEED = [
  {
    id: "h1",
    url: "https://demo.local/article/1",
    source_id: "demo:novel",
    title: "关于阅读器",
    source_name: "演示源",
    text: "行距、字号、版心宽度，任何一项不合适，都会在几页之内把人劝退。",
    note: "这条要留着提醒自己：别把默认值当结论。",
    created_at: 1_700_000_000,
  },
  {
    id: "h2",
    url: "https://demo.local/article/2",
    source_id: "demo:novel",
    title: "另一篇",
    source_name: "演示源",
    text: "记住读到哪儿同样重要，隔一天回来不用重新找位置。",
    note: "",
    created_at: 1_700_000_100,
  },
  {
    id: "h3",
    url: "https://demo.local/article/3",
    source_id: "demo:novel",
    title: "第三篇",
    source_name: "别的源",
    text: "版心的宽度应该跟着行长走，而不是反过来。",
    note: "版心与行长",
    created_at: 1_700_000_200,
  },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.HIGHLIGHT_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

const seed = () =>
  page.evaluate((items) => {
    const store = JSON.parse(localStorage.getItem("serious-dev-store") ?? "{}");
    localStorage.setItem("serious-dev-store", JSON.stringify({ ...store, highlights: items }));
  }, SEED);

/** The highlights as the store actually holds them. */
const stored = () =>
  page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("serious-dev-store") ?? "{}");
    return (store.highlights ?? []).map((h) => ({ id: h.id, note: h.note, text: h.text }));
  });

const rowCount = () => page.locator("[data-mark-row]").count();

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("text=打开划线列表", { timeout: 15000 });
  await seed();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("text=打开划线列表", { timeout: 15000 });
  await page.locator("button", { hasText: "打开划线列表" }).click();
  await page.waitForSelector("[data-mark-row]", { timeout: 10000 });
  assert.equal(await rowCount(), 3, "the seeded highlights did not all render");
  console.log(`  seeded ${await rowCount()} highlights`);

  // -- a note can be written in place ------------------------------------------
  await page.locator('[data-note-edit="h2"]').click();
  await page.waitForSelector("[data-note-editor]", { timeout: 5000 });
  await page.locator("[data-note-input]").fill("补记：这条其实和进度条有关。");
  await page.locator("[data-note-save]").click();
  await page.waitForSelector("[data-note-editor]", { state: "detached", timeout: 5000 });
  const afterSave = await stored();
  const h2 = afterSave.find((h) => h.id === "h2");
  console.log(`  保存后 store 里的 h2.note = ${JSON.stringify(h2.note)}`);
  assert.equal(h2.note, "补记：这条其实和进度条有关。", "the note was not written to the store");
  assert.ok(
    await page.locator("[data-note-editor]").count() === 0,
    "the editor stayed open after saving",
  );

  // -- cancelling leaves the note alone ----------------------------------------
  await page.locator('[data-note-edit="h3"]').click();
  await page.waitForSelector("[data-note-input]", { timeout: 5000 });
  await page.locator("[data-note-input]").fill("这段文字不会保存");
  await page.locator("[data-note-cancel]").click();
  await page.waitForSelector("[data-note-editor]", { state: "detached", timeout: 5000 });
  const afterCancel = (await stored()).find((h) => h.id === "h3");
  console.log(`  取消后 store 里的 h3.note = ${JSON.stringify(afterCancel.note)}`);
  assert.equal(afterCancel.note, "版心与行长", "cancelling still changed the note");

  // -- clearing the note keeps the highlight ------------------------------------
  // Enter inside the editor belongs to the textarea, not to the row that would
  // otherwise open the article.
  await page.locator('[data-note-edit="h2"]').click();
  await page.waitForSelector("[data-note-input]", { timeout: 5000 });
  await page.locator("[data-note-input]").fill("第一行");
  await page.locator("[data-note-input]").press("Enter");
  await page.locator("[data-note-input]").type("第二行");
  const draft = await page.locator("[data-note-input]").inputValue();
  const editorStillOpen = await page.locator("[data-note-editor]").count();
  console.log(`  在笔记里按回车：草稿=${JSON.stringify(draft)}，编辑器仍在=${editorStillOpen === 1}`);
  assert.equal(draft, "第一行\n第二行", "Enter inside the editor did not reach the textarea");
  assert.equal(editorStillOpen, 1, "Enter inside the editor closed it (the row handled the key)");
  await page.locator("[data-note-cancel]").click();
  await page.waitForSelector("[data-note-editor]", { state: "detached", timeout: 5000 });

  await page.locator('[data-note-clear="h3"]').click();
  await page.waitForTimeout(300);
  const afterClear = await stored();
  const h3 = afterClear.find((h) => h.id === "h3");
  console.log(
    `  清除笔记后：共 ${afterClear.length} 条，h3.note = ${JSON.stringify(h3.note)}`,
  );
  assert.equal(afterClear.length, 3, "clearing the note also removed the highlight");
  assert.equal(h3.note, "", "the note was not cleared");
  assert.ok(
    await page.locator('[data-note-clear="h3"]').count() === 0,
    "the 清除笔记 button is still offered for a highlight with no note",
  );

  // -- deleting asks first, and says different things ---------------------------
  await page.locator('[data-mark-delete="h1"]').click();
  await page.waitForSelector("[data-delete-confirm]", { timeout: 5000 });
  const withNote = (await page.locator("[data-delete-message]").innerText()).trim();
  console.log(`  有笔记时确认文案：「${withNote}」`);
  assert.match(withNote, /笔记也会一起删除/, "the warning does not mention the note");
  await page.locator("[data-delete-no]").click();
  assert.equal((await stored()).length, 3, "cancelling the confirmation still deleted it");

  // h3's note was cleared above, so it is the genuine no-note case — asking about
  // h2 would be asking about a highlight that now carries the note just typed.
  assert.equal(
    (await stored()).find((h) => h.id === "h3").note,
    "",
    "h3 is not a note-less highlight, so the second case would prove nothing",
  );
  await page.locator('[data-mark-delete="h3"]').click();
  await page.waitForSelector("[data-delete-confirm]", { timeout: 5000 });
  const withoutNote = (await page.locator("[data-delete-message]").innerText()).trim();
  console.log(`  无笔记时确认文案：「${withoutNote}」`);
  assert.notEqual(withNote, withoutNote, "both cases are given the same sentence");
  assert.ok(
    !/笔记/.test(withoutNote),
    `the note-less case still warns about a note: ${withoutNote}`,
  );

  // Deleting, and then putting it back.
  await page.locator("[data-delete-yes]").click();
  await page.waitForSelector("[data-undo-bar]", { timeout: 5000 });
  const afterDelete = await stored();
  console.log(`  确认删除后 store 里剩 ${afterDelete.length} 条，撤销条出现`);
  assert.equal(afterDelete.length, 2, "the highlight was not deleted");
  await page.locator("[data-undo]").click();
  await page.waitForTimeout(400);
  const afterUndo = await stored();
  const restored = afterUndo.find((h) => h.id === "h3");
  console.log(`  撤销后：共 ${afterUndo.length} 条，恢复的 h3.note = ${JSON.stringify(restored.note)}`);
  assert.equal(afterUndo.length, 3, "undo did not bring the highlight back");
  assert.equal(restored.note, "", "undo invented a note that was not there");

  // -- finding one among many --------------------------------------------------
  // A word in the body of exactly one highlight.
  await page.locator("[data-search-input]").fill("几页之内");
  await page.waitForTimeout(200);
  const bodyHits = await page.evaluate(() =>
    [...document.querySelectorAll("[data-mark-row]")].map((li) => li.getAttribute("data-mark-row")),
  );
  console.log(`  搜索正文词「几页之内」→ ${bodyHits.length} 行：${JSON.stringify(bodyHits)}`);
  assert.deepEqual(bodyHits, ["h1"], "searching a word that is only in one passage did not narrow to it");

  // 「版心」 really is in two passages, and both must survive: a search that
  // quietly drops a genuine match is worse than no search.
  await page.locator("[data-search-input]").fill("版心");
  await page.waitForTimeout(200);
  const bothHits = await page.evaluate(() =>
    [...document.querySelectorAll("[data-mark-row]")].map((li) => li.getAttribute("data-mark-row")),
  );
  console.log(`  搜索「版心」（确实出现在两条正文里）→ ${bothHits.length} 行：${JSON.stringify(bothHits)}`);
  assert.deepEqual(bothHits, ["h1", "h3"], "a genuine second match was dropped");

  // A word that exists only inside a note must find it too.
  await page.locator("[data-search-input]").fill("进度条");
  await page.waitForTimeout(200);
  const noteHits = await page.evaluate(() =>
    [...document.querySelectorAll("[data-mark-row]")].map((li) => li.getAttribute("data-mark-row")),
  );
  console.log(`  搜索只在笔记里的词「进度条」→ ${noteHits.length} 行：${JSON.stringify(noteHits)}`);
  assert.deepEqual(noteHits, ["h2"], "a keyword that exists only inside a note was not found");

  await page.locator("[data-search-input]").fill("");
  await page.locator("[data-only-notes]").click();
  await page.waitForTimeout(200);
  const notedOnly = await rowCount();
  const count = (await page.locator("[data-marks-count]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  只看有笔记 → ${notedOnly} 行，计数「${count}」`);
  assert.equal(notedOnly, 2, "the only-notes filter kept the wrong number of rows");
  assert.match(count, /2 \/ 3 条/, `the count does not say it is filtered: ${count}`);

  await page.locator("[data-clear-filters]").click();
  await page.waitForTimeout(200);
  assert.equal(await rowCount(), 3, "clearing the filters did not bring the rows back");

  await page.screenshot({ path: path.join(outDir, "marks-panel.png"), fullPage: true });
  console.log("  screenshot: test-results/marks-panel.png");
} catch (error) {
  failed = true;
  console.error("marks panel test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "marks-panel-failure.png"), fullPage: true });
    console.error("  failure screenshot: test-results/marks-panel-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);