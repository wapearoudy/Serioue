// Drives the real ReaderStatsPanel.
//
//   node scripts/reader-stats-test.mjs
//
// Needs `pnpm dev` running.
//
// What it proves:
//   - the numbers on screen are the ones the seeded records imply, not decoration
//   - three articles read today add up into one day
//   - an article read on another day is counted, but not as today
//   - one article left open for eight hours is capped at 30 minutes
//   - a session that crosses midnight is not credited entirely to one day
//   - articles are grouped by source, busiest first
//   - an empty history gets a sentence, not three zeroes
//   - a backend that cannot answer says so, and stops spinning
//
// The expectations are worked out by hand from the fixture below rather than
// recomputed in the page, so the test fails if the panel and the backend agree
// on something both of them got wrong.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const url =
  process.env.READER_STATS_PREVIEW_URL || "http://localhost:1420/reader-stats-preview.html";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded here; the system Edge is the same
  // engine and is always present on Windows.
  channel: process.env.READER_STATS_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1000, height: 860 } });
let failed = false;

/** Local midnight `days` away from today, as unix seconds. */
function midnight(days = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return Math.floor(d.getTime() / 1000);
}

/** A local wall-clock time `days` away from today. */
function at(days, hour, minute = 0) {
  return midnight(days) + hour * 3600 + minute * 60;
}

/**
 * Whether yesterday already belongs to a different week.
 *
 * The app counts weeks from Monday, so on a Monday "yesterday" is last week.
 * The fixture uses yesterday, and this keeps the expectations honest rather
 * than quietly skipping the assertion that day.
 */
const yesterdayIsLastWeek = new Date().getDay() === 1;

/** Write a fixture into the stub's localStorage-backed store. */
async function seed({ history, progress, progress_at }) {
  await page.evaluate(
    (store) => localStorage.setItem("serious-dev-store", JSON.stringify(store)),
    { history, progress, progress_at },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stats-body", { timeout: 15000 });
}

/** Read one card's numbers straight off the DOM. */
async function card(period) {
  const el = page.locator(`.stats-card[data-period="${period}"]`);
  await el.waitFor({ timeout: 5000 });
  return {
    articles: Number(await el.getAttribute("data-articles")),
    minutes: Number(await el.getAttribute("data-minutes")),
    text: (await el.innerText()).replace(/\s+/g, " ").trim(),
  };
}

const entry = (url, viewed_at, source_id, source_name) => ({
  id: url,
  source_id,
  title: url,
  url,
  source_name,
  viewed_at,
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

  // -- empty ---------------------------------------------------------------
  await seed({ history: [], progress: {}, progress_at: {} });
  const emptyText = (await page.locator(".stats-body").innerText()).trim();
  assert.match(emptyText, /还没有可统计的阅读/, `empty state is unhelpful: ${emptyText}`);
  assert.equal(
    await page.locator(".stats-card").count(),
    0,
    "an empty history must not render cards of zeroes",
  );
  console.log(`  empty state: ${emptyText.split("\n")[0]}`);

  // -- the backend cannot answer ---------------------------------------------
  // A panel that catches the error and then keeps showing a spinner forever is
  // a broken screen, not a slow one.
  await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem("serious-dev-store") ?? "{}");
    store.reading_stats_error = "progress.json 读取失败";
    localStorage.setItem("serious-dev-store", JSON.stringify(store));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stats-body", { timeout: 15000 });
  await page.waitForSelector(".empty", { timeout: 5000 });
  assert.equal(
    await page.locator(".spinner").count(),
    0,
    "a failed load left the spinner turning forever",
  );
  const failedText = (await page.locator(".stats-body").innerText()).replace(/\s+/g, " ").trim();
  assert.match(failedText, /统计没读出来/, `failure state is unhelpful: ${failedText}`);
  assert.match(failedText, /progress\.json 读取失败/, `the reason was not shown: ${failedText}`);
  console.log(`  failure state: ${failedText.slice(0, 60)}…`);

  // -- today: three articles, ten + twenty + fifteen minutes ----------------
  const a1 = at(0, 9, 0);
  const a2 = at(0, 11, 0);
  const a3 = at(0, 14, 30);
  const b1 = at(-1, 20, 0); // yesterday evening
  // Opened the night before yesterday and left open: eight hours of wall clock
  // across a midnight, capped at thirty minutes, and not counted as today.
  const overnight = at(-2, 22, 0);

  await seed({
    history: [
      entry("https://x.com/1", a1, "s1", "源 A"),
      entry("https://x.com/2", a2, "s1", "源 A"),
      entry("https://x.com/3", a3, "s2", "源 B"),
      entry("https://x.com/4", b1, "s1", "源 A"),
      entry("https://x.com/5", overnight, "s2", "源 B"),
    ],
    // Positions exist for every URL opened above.
    progress: {
      "https://x.com/1": 1,
      "https://x.com/2": 1,
      "https://x.com/3": 1,
      "https://x.com/4": 1,
      "https://x.com/5": 0.5,
    },
    progress_at: {
      // 10, 20 and 15 minutes on the same day.
      "https://x.com/1": a1 + 10 * 60,
      "https://x.com/2": a2 + 20 * 60,
      "https://x.com/3": a3 + 15 * 60,
      // Twenty minutes yesterday: in the week, but not today.
      "https://x.com/4": b1 + 20 * 60,
      // Eight hours of wall clock, closed the next morning: capped at 30.
      "https://x.com/5": overnight + 8 * 3600,
    },
  });

  const today = await card("today");
  assert.equal(today.articles, 3, `today's article count is wrong: ${JSON.stringify(today)}`);
  assert.equal(
    today.minutes,
    45,
    `today's minutes are wrong (10 + 20 + 15, and the overnight gap capped at 30): ${JSON.stringify(
      today,
    )}`,
  );
  assert.match(today.text, /^今日 3 篇 45 分钟/, `today card reads "${today.text}"`);
  console.log(`  today: ${today.text}`);

  // Today's three articles and the two older ones are the whole week, except
  // that yesterday falls out of it on a Monday.
  const week = await card("week");
  const weekArticles = yesterdayIsLastWeek ? 3 : 5;
  const weekMinutes = yesterdayIsLastWeek ? 45 : 95;
  assert.equal(
    week.articles,
    weekArticles,
    `this week's articles are wrong (${weekArticles} expected): ${JSON.stringify(week)}`,
  );
  assert.equal(
    week.minutes,
    weekMinutes,
    `this week's minutes are wrong (${weekMinutes} expected): ${JSON.stringify(week)}`,
  );
  console.log(`  week: ${week.text}`);

  const all = await card("all");
  assert.equal(all.articles, 5, `all-time articles are wrong: ${JSON.stringify(all)}`);
  assert.equal(all.minutes, 95, "all time should match the week in this fixture");
  console.log(`  all: ${all.text}`);

  // -- grouped by source ----------------------------------------------------
  const rows = await page.locator(".stats-src-row").allInnerTexts();
  const counts = rows.map((r) => r.replace(/\s+/g, " ").trim());
  assert.equal(counts.length, 2, `expected two sources, got ${JSON.stringify(counts)}`);
  assert.match(counts[0], /^源 A 3 篇$/, `busiest source is wrong: ${counts[0]}`);
  assert.match(counts[1], /^源 B 2 篇$/, `second source is wrong: ${counts[1]}`);
  console.log(`  by source: ${counts.join(" | ")}`);

  await page.screenshot({ path: path.join(outDir, "reader-stats.png") });
  console.log("  screenshot: test-results/reader-stats.png");

  // -- yesterday is not today ------------------------------------------------
  // Same fixture with today's articles removed: the week keeps yesterday's,
  // today drops to nothing, and the panel still shows numbers rather than an
  // empty state — there is data, it just is not from today.
  await seed({
    history: [entry("https://x.com/4", b1, "s1", "源 A")],
    progress: { "https://x.com/4": 1 },
    progress_at: { "https://x.com/4": b1 + 20 * 60 },
  });
  const onlyYesterday = await card("today");
  assert.equal(onlyYesterday.articles, 0, "yesterday's article was counted as today's");
  assert.equal(onlyYesterday.minutes, 0, "yesterday's minutes were counted as today's");
  assert.match(onlyYesterday.text, /不到 1 分钟/, `zero minutes read oddly: ${onlyYesterday.text}`);
  const yesterdayWeek = await card("week");
  assert.equal(yesterdayWeek.articles, yesterdayIsLastWeek ? 0 : 1);
  assert.equal(yesterdayWeek.minutes, yesterdayIsLastWeek ? 0 : 20);
  console.log(`  only yesterday: today "${onlyYesterday.text}" · week "${yesterdayWeek.text}"`);

  // -- across midnight -------------------------------------------------------
  // A session that starts at 23:50 and ends at 00:10 is ten minutes on each
  // side. Whichever day the panel calls "today", it must not show both.
  const late = at(-1, 23, 50);
  await seed({
    history: [entry("https://x.com/6", late, "s1", "源 A")],
    progress: { "https://x.com/6": 1 },
    progress_at: { "https://x.com/6": late + 20 * 60 },
  });
  const splitToday = await card("today");
  const splitAll = await card("all");
  assert.equal(splitAll.minutes, 20, `the whole session must still be counted: ${splitAll.text}`);
  assert.ok(
    splitToday.minutes < 20,
    `both halves of a midnight-crossing session landed on today (${splitToday.text})`,
  );
  console.log(
    `  across midnight: today ${splitToday.minutes} 分钟 · 全部 ${splitAll.minutes} 分钟`,
  );

  // -- the cap --------------------------------------------------------------
  // One article, eight hours of wall clock: at most thirty minutes, and the
  // panel must say so rather than showing 8 hours.
  const longStart = at(-2, 9, 0);
  await seed({
    history: [entry("https://x.com/7", longStart, "s1", "源 A")],
    progress: { "https://x.com/7": 1 },
    progress_at: { "https://x.com/7": longStart + 8 * 3600 },
  });
  const capped = await card("all");
  assert.equal(capped.minutes, 30, `an eight-hour gap was credited in full: ${capped.text}`);
  console.log(`  eight hours of wall clock counted as: ${capped.text}`);

  // -- an article with no saved position ------------------------------------
  // Opened but never scrolled: an article, but no evidence of any time.
  await seed({
    history: [entry("https://x.com/8", at(-1, 9, 0), "s1", "源 A")],
    progress: {},
    progress_at: {},
  });
  const noProgress = await card("all");
  assert.equal(noProgress.articles, 1, "an opened article should still be counted");
  assert.equal(noProgress.minutes, 0, "there is no evidence of any reading time");
  console.log(`  opened but never scrolled: ${noProgress.text}`);
} catch (error) {
  failed = true;
  console.error("reader stats test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "reader-stats-failure.png") });
    console.error("  failure screenshot: test-results/reader-stats-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
