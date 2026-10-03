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
