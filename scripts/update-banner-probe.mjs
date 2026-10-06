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
import { describeInstallerProvenance, pickNewestInstaller } from "./lib/installers.mjs";

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

// The installer is chosen by scripts/lib/installers.mjs and not here, because
// choosing it is the kind of one-liner that is wrong for years and then wrong
// quietly: `.sort().at(-1)` is a TEXT sort, so once the patch number reaches two
// digits `Serious_0.1.10` sorts before `Serious_0.1.9` and the older installer is
// served as the newest — with nothing to throw. The module carries that reasoning
// and its self-test (`node scripts/lib/installers.mjs`).
const { name: installerName, version: installerVersion, unparsed } = pickNewestInstaller(
  await readdir(bundle).catch(() => []),
);
if (!installerName) {
  console.error(
    `no installer in ${bundle}\n` +
      "build one first:\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content src-tauri\\serious-updater.key -Raw).Trim()\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''\n" +
      "  pnpm tauri build --bundles nsis\n" +
      "the signing key is required — without it there is no .sig to sign the manifest with" +
      (unparsed.length
        ? `\nnote: ${unparsed.join(", ")} matched the installer glob but carries no version this ` +
          "script can read, so it was NOT considered"
        : ""),
  );
  process.exit(1);
}
if (unparsed.length) {
  console.log(
    `note: ${unparsed.join(", ")} matched the installer glob but carries no version this ` +
      "script can read, so it was NOT considered",
  );
}
const installer = path.join(bundle, installerName);
const sigFile = `${installer}.sig`;
if (!existsSync(sigFile)) {
  console.error(
    `no signature next to ${path.basename(installer)} — was the bundle built signed?\n` +
      "rebuild it with the signing key (a bundle built without one produces no .sig):\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content src-tauri\\serious-updater.key -Raw).Trim()\n" +
      "  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''\n" +
      "  pnpm tauri build --bundles nsis",
  );
  process.exit(1);
}
console.log(`app version ${currentVersion}, serving ${newVersion} as the update`);
console.log(`installer: ${installerName}`);

// Say out loud which build is about to be served as "the new version". The served
// version is a fixture, so a mismatch is expected and is a warning, not a failure —
// the reasoning is in describeInstallerProvenance().
const provenance = describeInstallerProvenance({
  installerVersion,
  appVersion: currentVersion,
  servedVersion: newVersion,
});
console.log(provenance.message);

const PORT = 19555;
const ORIGIN = `https://127.0.0.1:${PORT}`;
const certDir = path.join(root, "test-results", "local-cert");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");
// Without this the next read throws a bare ENOENT that names a path but not the
// one command that produces it — the other two update legs already say what to run.
if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.error(
    `missing ${existsSync(keyPath) ? certPath : keyPath} — run: ` +
      "pwsh -NoProfile -File scripts/make-local-cert.ps1",
  );
  process.exit(1);
}
const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };
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