// Focused check: does the startup update banner ever appear?
//
// The update banner is driven by an event the backend emits ~1.5s after launch.
// The main test found no banner at all, which would mean "check on startup"
// silently finds the update and then shows the user nothing. That claim needs
// its own evidence before it is reported.
//
//   node scripts/update-banner-probe.mjs
//
// Needs the app built with the local channel endpoint and the cert trusted.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");
const bundle = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");

// Version and installer both come from outside this file. Naming a version here
// means the next release quietly stops finding it, and a probe that cannot find
// its fixture is worse than no probe at all.
const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const currentVersion = conf.version;
const [cMaj, cMin, cPatch] = currentVersion.split(".").map(Number);
const newVersion =
  process.env.SERIOUS_FAKE_UPDATE_VERSION ?? `${cMaj}.${cMin}.${cPatch + 1}`;

// The real files are `...-setup.exe` with a **hyphen**; a `_setup\.exe` pattern
// matches nothing and would report "no installer" with the files sitting there.
const installers = (await readdir(bundle).catch(() => [])).filter((name) =>
  /^Serious_.*setup\.exe$/i.test(name),
);
if (installers.length === 0) {
  console.error(
    `no installer in ${bundle}\n` +
      "build one first:\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content src-tauri\\serious-updater.key -Raw).Trim()\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''\n" +
      "  pnpm tauri build --bundles nsis\n" +
      "the signing key is required — without it there is no .sig to sign the manifest with",
  );
  process.exit(1);
}
const installer = path.join(bundle, installers.sort().at(-1));
const sigFile = `${installer}.sig`;
if (!existsSync(sigFile)) {
  console.error(
    `no signature next to ${path.basename(installer)} — was the bundle built signed?`,
  );
  process.exit(1);
}
console.log(`app version ${currentVersion}, serving ${newVersion} as the update`);

const PORT = 19555;
const ORIGIN = `https://127.0.0.1:${PORT}`;
const tls = {
  key: await readFile(path.join(root, "test-results", "local-cert", "key.pem")),
  cert: await readFile(path.join(root, "test-results", "local-cert", "cert.pem")),
};
const sig = (await readFile(sigFile, "utf8")).trim();
const size = statSync(installer).size;

const server = createHttpsServer(tls, (req, res) => {
  const p = new URL(req.url, ORIGIN).pathname;
  if (p === "/latest.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        version: newVersion,
        notes: "banner probe",
        pub_date: new Date("2026-01-15T10:00:00Z").toISOString(),
        platforms: { "windows-x86_64": { signature: sig, url: `${ORIGIN}/setup.exe` } },
      }),
    );
  } else if (p === "/setup.exe") {
    // Refuse any download: this probe is only about whether the banner shows.
    res.writeHead(500);
    res.end("no download in this probe");
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = await mkdtemp(path.join(os.tmpdir(), "banner-probe-"));
const cdpPort = 19495;
const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

let browser = null;
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("no CDP port");
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 20000 }));
  // The webview navigates once after CDP attaches; evaluating before that
  // settles destroys the execution context mid-call.
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForSelector(".sidebar", { timeout: 30000 });
  const t0 = Date.now();

  // The banner should already be present if the startup event reached the
  // listener; check immediately, then keep watching for a while.
  for (const label of ["immediately", "+3s", "+6s", "+10s", "+15s"]) {
    const state = await page.evaluate(() => ({
      sidebar: !!document.querySelector(".sidebar"),
      banners: document.querySelectorAll(".banner").length,
      anyBannerish: document.querySelectorAll('[class*="banner"]').length,
      foundText: document.body.innerText.includes("发现新版本"),
    }));
    console.log(
      `${label.padEnd(11)} (t≈${Date.now() - t0}ms)  sidebar=${state.sidebar} ` +
        `.banner=${state.banners} [class*=banner]=${state.anyBannerish} ` +
        `text "发现新版本"=${state.foundText}`,
    );
    if (label !== "+15s") await page.waitForTimeout(3000);
  }

  // Does a *manual* check put the text on screen? Same channel, no reload.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForSelector("button:has-text('检查更新')", { timeout: 10000 });
  await page.locator(".main-body button", { hasText: "检查更新" }).click();
  const manual = await page
    .locator(".main-body")
    .getByText(/发现新版本|还没有发布正式版本|无法连接 GitHub|检查更新时出错/)
    .first()
    .waitFor({ timeout: 40000 })
    .then((e) => (e.innerText()).replace(/\s+/g, " "))
    .catch(() => "(nothing)");
  console.log(`manual check shows: ${manual}`);
} finally {
  try {
    await browser?.close();
  } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  server.close();
}
process.exit(0);