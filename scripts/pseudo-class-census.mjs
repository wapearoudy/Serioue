// 独立侦察：Legado 的 `:matches(regex)` 扩展伪类，引擎目前没有实现。
//
// 这个统计的意义：如果几乎没有源用它，那"补上这个伪类"不值得做；如果成百上千
// 个源在用，那它是一个真实的覆盖缺口，优先级应该很高。
//
// 只统计，不下结论 —— 出现次数不等于失败次数。
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const COLLECTIONS = (process.env.PROBE_URLS ||
  "77,160,51,107,196")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((id) => `https://www.yck2026.fun/yuedu/rsss/json/id/${id}.json`);

// 引擎 selector.rs 里已实现的前缀，用来做「覆盖缺口」的对照
const IMPLEMENTED = ["tag.", "id.", "class.", "text."];
// 常见但可能没实现的 Legado 扩展，一并统计
const CANDIDATES = [":matches(", ":contains(", ":starts-with(", ":ends-with(", ":regex(", "@XPath", "$.", "$$."];

const tally = Object.fromEntries(CANDIDATES.map((c) => [c, { sources: 0, hits: 0 }]));
const perCollection = [];
let totalSources = 0;
const usersOfMatches = [];

for (const url of COLLECTIONS) {
  let list = [];
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    list = await res.json();
    if (!Array.isArray(list)) list = list.sources ?? list.data ?? [];
  } catch (e) {
    console.log(`${url}: 抓取失败 ${String(e).slice(0, 60)}`);
    continue;
  }

  const local = Object.fromEntries(CANDIDATES.map((c) => [c, 0]));
  for (const s of list) {
    totalSources++;
    const fields = [
      s.ruleArticles, s.ruleName, s.ruleLink, s.ruleContent, s.ruleBookList,
      s.ruleIntro, s.ruleCover, s.ruleNextPage, s.ruleToc, s.ruleFindSource,
    ].filter((v) => typeof v === "string");
    const blob = fields.join("\n");
    let any = false;
    for (const c of CANDIDATES) {
      const n = blob.split(c).length - 1;
      if (n > 0) {
        tally[c].hits += n;
        tally[c].sources += 1;
        local[c] += 1;
        any = true;
        if (c === ":matches(" && usersOfMatches.length < 8) {
          usersOfMatches.push({
            collection: url.split("/").pop(),
            name: s.sourceName ?? s.bookSourceName ?? "?",
            rule: (s.ruleArticles ?? "").slice(0, 160),
          });
        }
      }
    }
    if (any) local.__withAny = (local.__withAny ?? 0) + 1;
  }
  perCollection.push({ url, sources: list.length, local });
  console.log(`${url.split("/").pop()}: ${list.length} 个源`);
}

console.log(`\n=== 合计 ${totalSources} 个源 ===\n`);
console.log("构造/伪类出现情况（sources = 有多少个源用到，hits = 总出现次数）：");
for (const c of CANDIDATES) {
  const t = tally[c];
  const mark = c.startsWith(":") ? "  ← 引擎未实现" : "";
  console.log(`  ${c.padEnd(16)} ${String(t.sources).padStart(5)} 个源  ${String(t.hits).padStart(6)} 次${mark}`);
}

console.log("\n已实现的前缀（对照，说明这些不是缺口）：");
for (const p of IMPLEMENTED) {
  let n = 0;
  for (const pc of perCollection) void pc;
  console.log(`  ${p}`);
}

console.log("\n用 :matches( 的源（前 8 个）：");
for (const u of usersOfMatches) {
  console.log(`  [${u.collection}] ${u.name}`);
  console.log(`      ${u.rule}`);
}

mkdirSync(path.join(root, "test-results"), { recursive: true });
const dest = path.join(root, "test-results", "pseudo-class-census.json");
writeFileSync(dest, JSON.stringify({ totalSources, tally, perCollection, usersOfMatches }, null, 2), "utf8");
console.log(`\nwritten: ${dest}`);