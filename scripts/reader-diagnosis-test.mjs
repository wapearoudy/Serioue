// Does the reader ever find out that their rule is dead?
//
// The engine falls back to a page's raw links when a rule matches nothing, so
// the list looks perfectly normal and the source can stay broken for months
// without anyone noticing. That is what these two strings are for.
//
// The assertions are deliberately asymmetric. With a diagnosis, the test checks
// the reader can see it. Without one, it checks that **nothing at all** was
// added — an empty container or a stray layout pixel is a regression that a
// "is it visible?" check would sail straight past.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "test-results");
mkdirSync(outDir, { recursive: true });

// Verbatim from browse.rs `diagnose_list`, so the test pins the wording the
// reader actually sees rather than a paraphrase that can drift.
const RULE_DEAD =
  "这个源的规则在页面上一个都没匹配上，这里列的是页面上的链接（共 12 条）。规则可能已经过时了，换个源或重新收集规则会更好用。";
const CONTAINERS_ONLY =
  "规则匹配到了 3 个区块，但没能从中取出可打开的条目 —— 取标题或地址的那条规则多半已经对不上了。";

const url = "http://localhost:1420/reader-diagnosis-preview.html";

const browser = await chromium.launch({
  channel: process.env.READER_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

let failed = false;

try {
  // -- 1. a healthy source adds nothing at all --------------------------------
  await page.goto(`${url}?diagnosis=`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".card", { timeout: 15000 });

  const healthy = await page.evaluate(() => {
    const body = document.querySelector(".main-body");
    return {
      diagnosisNodes: document.querySelectorAll("[data-list-diagnosis]").length,
      // The children of the scroll body are what a reader could mistake for an
      // article, so that is what is counted.
      bodyChildren: body ? body.children.length : -1,
      bodyHtml: body ? body.innerHTML.length : -1,
      cards: document.querySelectorAll(".card").length,
      scrollHeight: body ? body.scrollHeight : -1,
    };
  });
  console.log(`  a healthy source: ${JSON.stringify(healthy)}`);
  assert.equal(healthy.diagnosisNodes, 0, "a healthy source grew a diagnosis row");
  assert.equal(healthy.cards, 12, `the fixture did not load: ${healthy.cards}`);

  // -- 2. the same page, now with a diagnosis ---------------------------------
  await page.goto(`${url}?diagnosis=${encodeURIComponent(RULE_DEAD)}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector(".card", { timeout: 15000 });

  const shown = page.locator("[data-list-diagnosis]");
  await shown.waitFor({ state: "visible", timeout: 10000 });
  const text = (await shown.innerText()).replace(/\s+/g, " ").trim();
  console.log(`  the reader is told: "${text}"`);
  assert.equal(text, RULE_DEAD.replace(/\s+/g, " ").trim(), "the wording drifted from the backend");

  // It must be readable by assistive technology, or it is only half delivered.
  assert.equal(
    await shown.getAttribute("role"),
    "status",
    "the diagnosis is not announced when it appears",
  );

  // And it must not be clickable: it is not an article, and the rows below it are.
  const clickable = await page.evaluate(() => {
    const el = document.querySelector("[data-list-diagnosis]");
    return {
      tag: el.tagName,
      isButton: el.getAttribute("role") === "button",
      hasTabIndex: el.hasAttribute("tabindex"),
      insideGrid: !!el.closest(".grid"),
      cardsAreClickable: document.querySelectorAll('.card[role="button"]').length,
    };
  });
  console.log(`  the row itself: ${JSON.stringify(clickable)}`);
  assert.equal(clickable.isButton, false, "the diagnosis is dressed up as something clickable");
  assert.equal(clickable.hasTabIndex, false, "the diagnosis is in the tab order");
  assert.equal(clickable.insideGrid, false, "the diagnosis is mixed in with the articles");
  assert.ok(clickable.cardsAreClickable > 0, "the fixture has no real article rows to be confused with");

  // -- 3. the second wording, and that it survives a category switch ----------
  await page.goto(`${url}?diagnosis=${encodeURIComponent(CONTAINERS_ONLY)}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.locator("[data-list-diagnosis]").waitFor({ state: "visible", timeout: 10000 });
  const second = (await page.locator("[data-list-diagnosis]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  the other wording: "${second}"`);
  assert.equal(second, CONTAINERS_ONLY.replace(/\s+/g, " ").trim(), "the second wording drifted");

  // A category whose load carries no diagnosis must not keep the old one up:
  // a stale warning accuses a list that is about to be shown and may be fine.
  await page.locator(".cat").nth(1).click();
  await page.waitForFunction(() => !document.querySelector("[data-list-diagnosis]"), null, {
    timeout: 10000,
  });
  const afterSwitch = await page.evaluate(() => ({
    diagnosisNodes: document.querySelectorAll("[data-list-diagnosis]").length,
    cards: document.querySelectorAll(".card").length,
  }));
  console.log(`  after switching to a healthy category: ${JSON.stringify(afterSwitch)}`);
  assert.equal(afterSwitch.diagnosisNodes, 0, "the previous category's diagnosis stayed on screen");
  assert.ok(afterSwitch.cards > 0, "switching category emptied the list");

  await page.screenshot({ path: join(outDir, "reader-diagnosis.png") });
  console.log("  screenshot: test-results/reader-diagnosis.png");
} catch (e) {
  failed = true;
  console.log(`reader diagnosis test failed: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(outDir, "reader-diagnosis-failure.png") }).catch(() => {});
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
