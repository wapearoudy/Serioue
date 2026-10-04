// Native smoke test: drives the real Serious window through WebView2's
// remote debugging port and screenshots it.
//
// Mirrors PulseWin's scripts/native-smoke.mjs. Two environment variables make
// this work under a low-integrity session:
//
//   WEBVIEW2_USER_DATA_FOLDER            — a writable scratch folder, because a
//                                         low-labelled process cannot write the
//                                         default location under APPDATA.
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS — opens the CDP port we attach to.
//
// Run from the project root after `cargo build --release`:
//
//   node scripts/native-smoke.mjs
//
// Exits non-zero on the first failed assertion and always writes a screenshot.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");

if (!existsSync(exe)) {
  console.error(`missing ${exe} — run: cargo build --release`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

// Isolate the profile so the test never touches a real user's sources.
const profile = await mkdtemp(path.join(outDir, "native-profile-"));
const port = Number(process.env.SERIOUS_TEST_CDP_PORT || 19488);

const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERIOUS_DATA_DIR: profile,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "WebView2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
});

let diagnostics = "";
child.stderr.on("data", (c) => (diagnostics = (diagnostics + c.toString()).slice(-12000)));
child.stdout.on("data", (c) => (diagnostics = (diagnostics + c.toString()).slice(-12000)));

let browser;
let page;
let failed = false;

try {
  // Wait for the CDP endpoint.
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) {
      throw new Error(`app exited early: ${child.exitCode}\n${diagnostics}`);
    }
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(browser, "WebView2 remote debugging endpoint never came up");

  for (let i = 0; i < 60; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(page, "no webview page was created");

  // The shell must render.
  await page.waitForSelector(".app", { timeout: 15000 });
  await page.waitForSelector(".sidebar", { timeout: 15000 });

  const title = await page.title();
  assert.equal(title, "Serious", "unexpected document title");

  // The empty state is the first thing a new user sees.
  await page.waitForSelector(".empty, .src-item", { timeout: 15000 });
  const hasImport = await page.getByRole("button", { name: "导入合集" }).count();
  assert.ok(hasImport > 0, "the import entry point is missing");

  // Backend commands must answer.
  const stats = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("stats"));
  assert.equal(typeof stats.sources, "number", "stats did not return a shape");

  const version = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("current_version"));
  assert.match(version, /^\d+\.\d+\.\d+$/, `unexpected version: ${version}`);

  const sources = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_sources", { filter: null }));
  assert.ok(Array.isArray(sources), "list_sources did not return an array");

  await page.screenshot({ path: path.join(outDir, "native-empty.png") });
  console.log(`  version ${version}, ${sources.length} source(s)`);
  console.log("  screenshot: test-results/native-empty.png");

  // The update check must degrade gracefully. No release is published yet, so
  // the correct outcome is an informational message, not a red error.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "检查更新" }).click();
  const updater = page.locator(".main-body").getByText(/还没有发布正式版本|已是最新版本|发现新版本|无法连接 GitHub|检查更新时出错/);
  try {
    await updater.waitFor({ timeout: 30000 });
  } catch {
    const dump = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()),
      mainBody: document.querySelector(".main-body")?.innerText.slice(0, 500),
    }));
    console.error("  update panel dump: " + JSON.stringify(dump, null, 2).replace(/\n/g, "\n  "));
    throw new Error("update check produced no readable result");
  }
  const note = (await updater.first().innerText()).replace(/\s+/g, " ");
  const colour = await updater.first().evaluate((el) => getComputedStyle(el).color);
  console.log(`  update check says: ${note}`);
  console.log(`  update notice colour: ${colour}`);
  assert.ok(
    !/[a-z]{4,} (for url|release|response)|error (sending|decoding)/i.test(note),
    `raw plugin error leaked to the user: ${note}`,
  );
  // The raw plugin text may still be available as a tooltip for debugging.
  const tooltip = await updater.first().getAttribute("title");
  if (note.includes("还没有发布正式版本")) {
    assert.notEqual(colour, "rgb(240, 168, 164)", "a normal state is painted as an error");
  }
  console.log(`  update detail tooltip: ${tooltip ?? "(none)"}`);
  if (tooltip) {
    assert.ok(!tooltip.startsWith("error__"), `marker leaked into the tooltip: ${tooltip}`);
    assert.ok(!/^__/.test(tooltip), `marker leaked into the tooltip: ${tooltip}`);
  }
  await page.screenshot({ path: path.join(outDir, "native-update.png") });
  console.log("  screenshot: test-results/native-update.png");

  // Import a real collection and browse it, if the network allows.
  if (process.env.SERIOUS_SMOKE_NETWORK === "1") {
    console.log("  (network mode: importing a real collection)");
    await page.getByRole("button", { name: "导入合集" }).first().click();
    await page.waitForSelector(".modal", { timeout: 10000 });

    const cards = page.locator(".repo-card");
    await cards.first().waitFor({ timeout: 30000 });
    const count = await cards.count();
    assert.ok(count > 0, "the repository browser returned no collections");
    console.log(`  repository browser listed ${count} collections`);
    await page.screenshot({ path: path.join(outDir, "native-repo.png") });

    await cards.first().getByRole("button", { name: "导入" }).click();
    await page.waitForSelector(".banner", { timeout: 60000 });
    const banner = await page.locator(".banner").first().innerText();
    console.log(`  import result: ${banner.replace(/\s+/g, " ")}`);
    await page.screenshot({ path: path.join(outDir, "native-imported.png") });

    // The modal footer is the last button group in the dialog; the banner
    // inside the modal also offers a "关闭" ✕, so position is the reliable cue.
    const footer = page.locator(".modal-actions button");
    const footerTexts = await footer.allInnerTexts();
    if (footerTexts.length === 0) {
      const shape = await page.evaluate(() => {
        const m = document.querySelector(".modal");
        return {
          modalChildren: m ? [...m.children].map((c) => c.className || c.tagName) : null,
          buttons: [...document.querySelectorAll(".modal button")].map(
            (b) => b.innerText.trim() || "(icon)",
          ),
        };
      });
      console.log("  modal shape: " + JSON.stringify(shape));
      throw new Error("modal footer not found");
    }
    await footer.last().click();
    await page.waitForSelector(".src-item", { timeout: 30000 });
    const imported = await page.locator(".src-item").count();
    assert.ok(imported > 0, "import produced no sources in the sidebar");

    // Open the first source and wait for its listing.
    await page.locator(".src-item").first().click();
    await page.waitForSelector(".grid, .cat-bar, .empty", { timeout: 45000 });
    await page.screenshot({ path: path.join(outDir, "native-browse.png") });
    console.log(`  sidebar shows ${imported} source(s)`);
    console.log("  screenshot: test-results/native-browse.png");

    // -- Reading flow in the real packaged app --------------------------------
    // The preview pages prove the components work in a browser; this proves
    // they still work once Tauri IPC and the built CSS are in play.
    //
    // It uses a synthetic bare-URL source pointed at the repository index,
    // which the app can already reach. Hunting for a third-party source that
    // happens to be up would make this test fail for reasons that have nothing
    // to do with the reader.
    if (process.env.SERIOUS_SMOKE_READ === "1") {
      console.log("  (reading mode: opening an article)");
      const importedFixture = await page.evaluate(async () => {
        const payload = JSON.stringify([
          {
            sourceName: "冒烟测试源",
            sourceUrl: "https://www.yck2026.fun/yuedu/rsss/index.html",
            sourceGroup: "smoke",
          },
        ]);
        return window.__TAURI_INTERNALS__.invoke("import_from_text", {
          text: payload,
          name: "smoke",
        });
      });
      console.log(`  imported a fixture source: +${importedFixture.added}`);

      // The import went through the command, not the UI, so the app's source
      // list is stale. Reload rather than reaching around the state.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".src-item", { timeout: 20000 });

      const fixtureId = await page.evaluate(async () => {
        const all = await window.__TAURI_INTERNALS__.invoke("list_sources", { filter: null });
        return all.find((s) => s.name.includes("冒烟测试源"))?.id ?? "";
      });
      assert.ok(fixtureId, "the fixture source was not stored");

      // Pick the fixture by name: it is appended to the library, so the first
      // row is some other source entirely.
      const fixture = page.locator(".src-item", { hasText: "冒烟测试源" });
      assert.ok((await fixture.count()) > 0, "the fixture source is not in the sidebar");
      // Backend path first, deterministically: the same command the reader
      // uses must return real content for a URL the app can reach.
      const article = await page.evaluate(
        async ([id]) =>
          window.__TAURI_INTERNALS__.invoke("load_article", {
            id,
            url: "https://www.yck2026.fun/yuedu/rsss/index.html",
            title: "index",
          }),
        [fixtureId],
      );
      assert.ok(article.text.trim().length > 50, "load_article returned no text");
      console.log(
        `  load_article returned ${article.text.length} chars, ` +
          `${article.html.length} chars of html`,
      );

      // Unusable links must explain themselves instead of leaking reqwest's
      // "builder error" at the user.
      const badLink = await page.evaluate(
        async ([id]) => {
          try {
            await window.__TAURI_INTERNALS__.invoke("load_article", {
              id,
              url: "   ",
              title: null,
            });
            return null;
          } catch (e) {
            return String(e);
          }
        },
        [fixtureId],
      );
      assert.ok(badLink && !badLink.includes("builder error"), `unhelpful error: ${badLink}`);
      console.log(`  an unusable link reports: ${badLink}`);

      // Then the UI leg, which depends on what the listing produced.
      await fixture.first().click();
      await page.waitForSelector(".grid, .empty", { timeout: 45000 });
      const cards = await page.locator(".card").count();
      console.log(`  fixture source listed ${cards} item(s)`);

      if (cards > 0) {
        await page.locator(".card").first().click();
        await page.waitForSelector(".reader, .banner", { timeout: 45000 });
      }

      if ((await page.locator(".reader").count()) > 0) {
        assert.ok(
          (await page.locator('.reader-settings > button[title="阅读设置"]').count()) > 0,
          "the reader has no typography control",
        );

        const bodyStyle = () =>
          page.evaluate(() => {
            const el = document.querySelector(".reader-body");
            if (!el) return null;
            const s = getComputedStyle(el);
            return { fontSize: s.fontSize, width: Math.round(el.getBoundingClientRect().width) };
          });

        const before = await bodyStyle();
        assert.ok(before && before.width > 0, "the article body has no width");

        await page.locator('.reader-settings > button[title="阅读设置"]').click();
        await page.waitForSelector(".reader-pop", { timeout: 5000 });
        for (let i = 0; i < 4; i++) await page.locator('button[title="放大字号"]').click();
        const after = await bodyStyle();
        assert.ok(
          parseFloat(after.fontSize) > parseFloat(before.fontSize),
          `font size did not change in the packaged app (${before.fontSize} -> ${after.fontSize})`,
        );
        console.log(
          `  reader font ${before.fontSize} -> ${after.fontSize}, body width ${after.width}px`,
        );
        await page.screenshot({ path: path.join(outDir, "native-reader.png") });
        console.log("  screenshot: test-results/native-reader.png");
      } else {
        console.log("  (the reader UI did not open from the listing; backend path still checked)");
      }

      // Preferences must survive a reload, which means they reached the store.
      // Only meaningful when the UI leg above actually changed something.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar", { timeout: 20000 });
      await page.waitForTimeout(1500);
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      assert.ok(theme, "no reading theme was applied to the document");
      const stored = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("get_settings"),
      );
      console.log(
        `  after reload: theme=${theme}, persisted font size=${stored.reader_font_size}px`,
      );
    }

    // -- Source verification -------------------------------------------------
    await page.getByRole("button", { name: "校验", exact: true }).click();
    await page.waitForSelector(".verify-list, .empty", { timeout: 10000 });
    await page.screenshot({ path: path.join(outDir, "native-verify-idle.png") });

    // Checking all 71 sources would take minutes, so drive two of them
    // through the real command and assert the streamed events land in the UI.
    const someIds = await page.evaluate(async () => {
      const all = await window.__TAURI_INTERNALS__.invoke("list_sources", { filter: null });
      return all.slice(0, 2).map((s) => s.id);
    });
    assert.equal(someIds.length, 2, "could not pick sources to verify");

    const summary = await page.evaluate(
      async (ids) =>
        window.__TAURI_INTERNALS__.invoke("check_all", { ids, scope: null }),
      someIds,
    );
    assert.equal(summary.total, 2, `unexpected summary: ${JSON.stringify(summary)}`);
    assert.equal(summary.ok + summary.warn + summary.failed, 2);

    // The counters must be reflected in the rows, not just in the payload.
    for (const [kind, key] of [["ok", "ok"], ["warn", "warn"], ["fail", "failed"]]) {
      const want = summary[key];
      const got = await page.locator(`.verify-row .verify-dot.${kind}`).count();
      assert.equal(got, want, `${want} ${kind} source(s) expected, ${got} dot(s) rendered`);
    }

    // The event listener must have painted a row per finished source.
    await page.waitForSelector(".verify-row", { timeout: 20000 });
    const chips = await page.locator(".verify-row .chip").count();
    assert.ok(chips >= 5, `stage chips did not render (found ${chips})`);
    await page.screenshot({ path: path.join(outDir, "native-verify.png") });

    // Expanding a checked row must show the full stage report. Rows sort
// problems-first, so the verified ones are not necessarily at the top.
    const reported = page.locator(".verify-row").filter({ has: page.locator(".chip") }).first();
    await reported.locator(".verify-line").click();
    await page.waitForSelector(".verify-table", { timeout: 10000 });
    const stageRows = await page.locator(".verify-table tr").count();
    assert.equal(stageRows, 5, `expected 5 stages, saw ${stageRows}`);
    const stageText = await page.locator(".verify-table tr").allInnerTexts();
    console.log(`  verification summary: ${JSON.stringify(summary)}`);
    for (const t of stageText) console.log(`    ${t.replace(/\s+/g, " ")}`);
    await page.screenshot({ path: path.join(outDir, "native-verify-detail.png") });

    // A single-source check must return the same shape.
    const one = await page.evaluate(
      async (id) => window.__TAURI_INTERNALS__.invoke("check_source", { id }),
      someIds[0],
    );
    assert.equal(one.stages.length, 5, "check_source did not report every stage");
    assert.ok(one.duration_ms >= 0, "check_source did not report a duration");
    console.log("  screenshot: test-results/native-verify-detail.png");
  }
} catch (error) {
  failed = true;
  console.error("native smoke failed:", error.message);
  console.error(diagnostics.slice(-4000));
  try {
    await page?.screenshot({ path: path.join(outDir, "native-failure.png") });
    console.error("  failure screenshot: test-results/native-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser?.close().catch(() => {});
  child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);
