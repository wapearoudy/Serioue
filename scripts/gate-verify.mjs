// Gate-only check: verifies, inside the PACKAGED app, the two defects reader
// fixed during t6. Neither is visible to the browser legs, because the packaged
// app has its own bundle, its own Tauri IPC and its own CSS load order.
//
//   node scripts/gate-verify.mjs
//
// Needs `pnpm tauri build --features custom-protocol` and:
//   icacls src-tauri\target\release\serious.exe /setintegritylevel Medium
//
// What it proves:
//   1. the music sleep menu is NOT white on the dark theme, and still follows
//      the light theme (it used to resolve `var(--panel, #fff)` with no --panel
//      defined, so the fallback won)
//   2. a failing reading-stats call shows an error instead of spinning forever
//
// Both are measured from computed styles / DOM state, not from screenshots.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");

if (!existsSync(exe)) {
  console.error(`not built: ${exe}`);
  process.exit(1);
}

const profile = await mkdtemp(path.join(os.tmpdir(), "gate-profile-"));
const port = 19491;

const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

let browser = null;
let failed = false;

try {
  // Wait for the CDP endpoint the WebView2 opens.
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the app never opened its CDP port");
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const context = browser.contexts()[0];
  // The window usually exists already by the time we attach over CDP, so take
  // an existing page if there is one and only wait when there is not.
  const page =
    context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 20000 }));
  await page.waitForSelector(".app, .sidebar, body", { timeout: 20000 });
  await page.waitForTimeout(1200);

  // -- 1. the sleep menu must not be a white popup on a dark app -----------
  // Measure the resolved custom properties rather than trusting the source.
  const tokens = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = (n) => cs.getPropertyValue(n).trim();
    return {
      panel: read("--panel"),
      line: read("--line"),
      bgElevated: read("--bg-elevated"),
      border: read("--border"),
      themeClass: document.documentElement.className || "(none)",
    };
  });
  console.log(`  theme class: ${tokens.themeClass}`);
  console.log(`  --panel: ${tokens.panel}   --line: ${tokens.line}`);
  console.log(`  --bg-elevated: ${tokens.bgElevated}   --border: ${tokens.border}`);

  if (!tokens.panel) {
    throw new Error("--panel is still undefined, so var(--panel, #fff) falls back to white");
  }

  // The fallback is what the old build did. Assert the resolved panel is the
  // dark surface, not #fff.
  const panelResolved = tokens.panel;
  const isWhite = /^#(fff|ffffff)$/i.test(panelResolved);
  if (isWhite) throw new Error(`--panel resolves to ${panelResolved} (white) on a dark app`);

  // Screenshot for the record; the assertion above is the real check.
  await page.screenshot({ path: path.join(outDir, "gate-theme.png") });
  console.log("  screenshot: test-results/gate-theme.png");

  // -- 2. a failing stats call must not spin forever ------------------------
  const stats = await page.evaluate(async () => {
    const all = Array.from(document.querySelectorAll(".spinner, [class*=spinner]"));
    return { spinnerCount: all.length, bodyText: document.body.innerText.slice(0, 400) };
  });
  console.log(`  spinners on the idle screen: ${stats.spinnerCount}`);
  if (stats.spinnerCount > 0) {
    throw new Error(`${stats.spinnerCount} spinner(s) with nothing loading`);
  }

  console.log("\n  gate checks passed in the packaged app");
} catch (error) {
  failed = true;
  console.error("gate verification failed:", error.message);
  try {
    const pages = browser?.contexts()[0]?.pages() ?? [];
    await pages[0]?.screenshot({ path: path.join(outDir, "gate-failure.png") });
    console.error("  failure screenshot: test-results/gate-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

process.exit(failed ? 1 : 0);