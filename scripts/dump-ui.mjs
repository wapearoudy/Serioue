// Dumps what the real window actually renders, as text.
// Screenshots prove the pixels; this proves the content.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");
await mkdir(outDir, { recursive: true });

const profile = await mkdtemp(path.join(outDir, "dump-profile-"));
const port = 19490;

const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SERIOUS_DATA_DIR: profile,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "WebView2"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  },
});

let browser, page;
const log = (m) => console.log(m);

try {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  for (let i = 0; i < 60; i++) {
    page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.waitForSelector(".app", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200));

  // Layout facts.
  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const app = rect(q(".app"));
    const side = rect(q(".sidebar"));
    const main = rect(q(".main"));
    const cs = getComputedStyle(document.body);
    return {
      url: location.href,
      title: document.title,
      bodyBg: cs.backgroundColor,
      bodyColor: cs.color,
      app: app && { w: Math.round(app.width), h: Math.round(app.height) },
      sidebar: side && { x: Math.round(side.x), w: Math.round(side.width) },
      main: main && { x: Math.round(main.x), w: Math.round(main.width) },
      hasScrollbar: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  log("PAGE  " + JSON.stringify(info, null, 2));

  // Every visible string on screen.
  const text = await page.evaluate(() => {
    const out = [];
    const walk = (el) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          const t = n.textContent.trim();
          if (t) out.push(t);
        } else if (n.nodeType === 1 && n.offsetParent !== null) {
          walk(n);
        }
      }
    };
    walk(document.body);
    return out;
  });
  log("\nVISIBLE TEXT\n" + text.join("\n"));

  // Button inventory.
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll("button")].map((b) => b.innerText.trim() || "(icon)"),
  );
  log("\nBUTTONS: " + JSON.stringify(buttons));
} catch (e) {
  console.error("dump failed:", e.message);
} finally {
  await browser?.close().catch(() => {});
  child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
