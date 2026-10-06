// End-to-end check of the whole "check for updates" path, without GitHub.
//
//   node scripts/update-channel-test.mjs
//
// GitHub has no published release, so this path had never actually run. This
// stands up a local HTTP server that impersonates the update channel and serves
// whatever the current case calls for, then drives the PACKAGED app and reads
// the strings the user would see.
//
// The app's endpoint is compiled in (`src-tauri/tauri.conf.json`), so the app
// must have been built with `endpoints` pointing at this server's port. The port
// is fixed on purpose: every case below is a different *server response*, not a
// different build, so one build covers all of them.
//
// Cases:
//
//   good      a real manifest, correct signature  -> a new version is reported
//   badsig    valid base64, wrong content         -> the app must refuse it
//   notfound  404                                  -> "no release published"
//   garbage   malformed latest.json                -> a generic failure
//   offline   server not listening                 -> "cannot reach GitHub"
//
// Nothing here touches implementation code; the point is to observe what the UI
// says, not to reason about classify() in isolation.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");
const bundle = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");

// Versions come from the one place that defines them. Pinning them here would
// make this script go quietly stale at the next release: it would look for an
// installer that is no longer produced, and compare the wrong pair of versions
// while still printing "ok".
const tauriConf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const CURRENT_VERSION = tauriConf.version;

// The "new" version is derived, never typed: patch+1 of whatever the app says it
// is. Override with SERIOUS_FAKE_UPDATE_VERSION when a test needs a specific gap.
const [cMaj, cMin, cPatch] = CURRENT_VERSION.split(".").map(Number);
const NEW_VERSION =
  process.env.SERIOUS_FAKE_UPDATE_VERSION ??
  `${cMaj}.${cMin}.${cPatch + 1}`;

// The installer is found by globbing. A path pinned to one version throws on the
// next release, and gets deleted rather than fixed.
//
// Note the pattern: the real files are `...-setup.exe` with a **hyphen**, so a
// `_setup\.exe` pattern matches nothing at all and reports "no installer" while
// the files are sitting right there.
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
      "the signing key is required, otherwise no .sig is produced and there is nothing to verify",
  );
  process.exit(1);
}
if (installers.length > 1) {
  console.log(`several installers present, using the newest: ${installers.join(", ")}`);
}
const installer = path.join(bundle, installers.sort().at(-1));
const sigFile = `${installer}.sig`;
if (!existsSync(sigFile)) {
  console.error(
    `no signature next to ${path.basename(installer)} (${path.basename(sigFile)})\n` +
      "the bundle was built without a signing key, so there is nothing to verify",
  );
  process.exit(1);
}
console.log(`app version ${CURRENT_VERSION}, serving ${NEW_VERSION} as the update`);
console.log(`installer: ${path.basename(installer)}`);

const PORT = 19555;
const ORIGIN = `https://127.0.0.1:${PORT}`;

// The updater plugin refuses to start on a plain http:// endpoint ("The
// configured updater endpoint must use a secure protocol like https"), so the
// fake channel speaks TLS with a certificate for 127.0.0.1 that the *user* root
// store trusts. Generate it first:
//   pwsh -NoProfile -File scripts/make-local-cert.ps1
const certDir = path.join(root, "test-results", "local-cert");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");
if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.error(`missing ${certPath} — run: pwsh -NoProfile -File scripts/make-local-cert.ps1`);
  process.exit(1);
}
const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };

if (!existsSync(exe)) {
  console.error(`not built: ${exe}`);
  process.exit(1);
}
if (!existsSync(installer) || !existsSync(sigFile)) {
  console.error(`missing signed artifacts under ${path.dirname(installer)}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Does the pubkey in tauri.conf.json really match the key that signed the
// installer on disk?
//
// This is settled by arithmetic rather than by reading a field: the .sig is a
// minisign signature, and Ed25519 verification needs only the *public* key. If
// it verifies, then the configured pubkey and the private key behind the local
// artifact are the same pair — which is otherwise unknowable from here, since
// the signing secret lives in a GitHub Secret and never appears in the repo.
//
// Doing it here rather than in the app is deliberate: verifying in the app means
// letting the download finish, and a *successful* verification is followed
// immediately by launching the installer.
// ---------------------------------------------------------------------------
const conf = JSON.parse(
  await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const confPubkey = conf.plugins.updater.pubkey.trim();

function parseMinisignPublicKey(configValue) {
  // The config holds base64 of the whole minisign block:
  //   untrusted comment: minisign public key: <KEYID>\n<KEYID>\n<BASE64>
  // The trailing base64 decodes to 42 bytes: 2-byte algorithm, 8-byte key id,
  // then the 32-byte Ed25519 key.
  const text = Buffer.from(configValue.trim(), "base64").toString("utf8");
  const b64 = text.trim().split("\n").pop().trim();
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 42) throw new Error(`unexpected public key length ${raw.length}`);
  return { keyId: raw.subarray(2, 10).toString("hex"), ed25519: raw.subarray(10, 42) };
}

function parseMinisignSignature(encoded) {
  // tauri writes the .sig file as base64 of minisign's four-line form:
  //   untrusted comment: ...
  //   <base64 of primary signature>
  //   trusted comment: ...
  //   <base64 of global signature>
  const text = Buffer.from(encoded.trim(), "base64").toString("utf8");
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  // Line 1 is a full minisign signature blob: 2-byte algorithm + 8-byte key id
  // + 64-byte Ed25519 signature = 74 bytes. The global signature is bare 64.
  const primaryBlob = Buffer.from(lines[1], "base64");
  if (primaryBlob.length !== 74) {
    throw new Error(`unexpected primary signature blob length ${primaryBlob.length}`);
  }
  const primarySig = primaryBlob.subarray(10, 74);
  const trustedLine = lines[2];
  const globalSig = Buffer.from(lines[3], "base64");
  if (globalSig.length !== 64) {
    throw new Error(`unexpected global signature length ${globalSig.length}`);
  }
  return { primaryAlg: primaryBlob.subarray(0, 2).toString("ascii"), primarySig, trustedLine, globalSig };
}

async function verifySignatureChain() {
  const crypto = await import("node:crypto");
  const { ed25519 } = parseMinisignPublicKey(confPubkey);
  const sig = parseMinisignSignature(realSig);
  const artifact = await readFile(installer);

  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), ed25519]),
    format: "der",
    type: "spki",
  });

  // 1. The primary signature is over the artifact. minisign's "ED" (upper case)
  //    algorithm is *prehashed*, so the signed payload is BLAKE2b-512 of the
  //    file rather than the file itself; tauri emits "ED".
  const primaryAlg = sig.primaryAlg;
  const primaryPayload = primaryAlg === "ED"
    ? crypto.createHash("blake2b512").update(artifact).digest()
    : artifact;
  const primaryOk = crypto.verify(null, primaryPayload, key, sig.primarySig);

  // 2. the global signature is over (primary signature || trusted comment).
  // Exactly which slice of the trusted-comment line is signed varies between
  // minisign versions, so each form is tried and the one that verifies is
  // reported — guessing one and declaring failure would be misleading.
  const commentCandidates = {
    "whole line": sig.trustedLine,
    "after prefix": sig.trustedLine.replace(/^trusted comment:\s*/, ""),
    "whole line + newline": `${sig.trustedLine}\n`,
  };
  let globalOk = false;
  let globalForm = null;
  for (const [name, comment] of Object.entries(commentCandidates)) {
    if (
      crypto.verify(
        null,
        Buffer.concat([sig.primarySig, Buffer.from(comment, "utf8")]),
        key,
        sig.globalSig,
      )
    ) {
      globalOk = true;
      globalForm = name;
      break;
    }
  }

  return {
    keyId: parseMinisignPublicKey(confPubkey).keyId,
    trustedComment: sig.trustedLine,
    globalForm,
    primaryOk,
    globalOk,
  };
}

const realSig = (await readFile(sigFile, "utf8")).trim();
const installerSize = statSync(installer).size;

/**
 * A throwaway "installer" that we sign with the real private key.
 *
 * Rejecting a bad signature only proves the verifier is not a no-op. To also
 * show that it *accepts* a good one, the download has to finish — and a
 * finished download immediately launches whatever was downloaded. Serving the
 * real installer would put a live NSIS installer on the machine, so instead a
 * tiny inert file is signed and served. Reaching "installing" then proves the
 * signature was accepted; the launch attempt that follows fails harmlessly.
 *
 * Returns null when no private key is present, and the case is then skipped
 * rather than faked.
 */
async function makeSignedDummy() {
  const keyPath = path.join(root, "src-tauri", "serious-updater.key");
  if (!existsSync(keyPath)) return null;
  const crypto = await import("node:crypto");
  const text = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64").toString("utf8");
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  // tauri writes the key as `rsign encrypted secret key`. Reading it would
  // mean reimplementing rsign's scrypt-based decryption, which is well outside
  // what this test is for — and guessing at it would produce a signature that
  // looks valid and means nothing. Skip instead of faking it.
  if (/rsign encrypted/i.test(lines[0] ?? "")) {
    return { unavailable: `key is rsign-encrypted (${lines[0]}) and cannot be read here` };
  }
  const raw = Buffer.from(lines[1], "base64"); // alg(2) + keyid(8) + seckey(64)
  if (raw.length !== 74) {
    return { unavailable: `unexpected secret key length ${raw.length}` };
  }
  const keyId = raw.subarray(2, 10);
  const seed = raw.subarray(10, 42);
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });

  // An inert file: not a program, so Windows cannot run it.
  const payload = Buffer.from("serious updater acceptance probe — not an executable\n", "utf8");
  const comment = `timestamp:1700000000\tfile:serious-updater-probe.bin\tversion:${NEW_VERSION}`;
  const primary = crypto.sign(
    null,
    crypto.createHash("blake2b512").update(payload).digest(),
    priv,
  );
  const global = crypto.sign(null, Buffer.concat([primary, Buffer.from(comment, "utf8")]), priv);

  const body = [
    "untrusted comment: signature from tauri secret key",
    primary.toString("base64"),
    `trusted comment: ${comment}`,
    global.toString("base64"),
    "",
  ].join("\n");
  return {
    payload,
    signature: Buffer.from(body, "utf8").toString("base64"),
    keyId: keyId.toString("hex"),
  };
}
const signedDummy = await makeSignedDummy();

// What the server answers with for /latest.json, swapped between cases.
let mode = "good";
let downloadSockets = [];
/** Throttle the installer so progress is observable without ever finishing. */
let throttleInstaller = false;
/**
 * Bytes actually written for the installer. Measured server-side on purpose:
 * the banner only exists if the startup event reached the webview, whereas this
 * number is true regardless of what the UI managed to render.
 */
let bytesServed = 0;

function manifest(signature, urlPath = `/Serious_${NEW_VERSION}_x64-setup.exe`) {
  return JSON.stringify({
    version: NEW_VERSION,
    notes: "本地假更新源，用于验证检查更新链路。",
    pub_date: new Date("2026-01-15T10:00:00Z").toISOString(),
    platforms: {
      "windows-x86_64": {
        signature,
        url: `${ORIGIN}${urlPath}`,
      },
    },
  });
}

/** Valid base64, wrong content — the shape a tampered manifest would have. */
function plausibleButWrongSignature() {
  const junk = Buffer.alloc(64, 0x41).toString("base64"); // "AAAA…"
  return `untrusted comment: signature from tauri secret key\n${junk}\n`;
}

const server = createHttpsServer(tls, (req, res) => {
  const url = new URL(req.url, ORIGIN);

  if (url.pathname === "/latest.json") {
    if (mode === "notfound") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }
    if (mode === "garbage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{ this is not valid json ]]");
      return;
    }
    if (mode === "goodsig-probe") {
      if (!signedDummy) {
        res.writeHead(500);
        res.end("no signing key on this machine");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(manifest(signedDummy.signature, "/serious-updater-probe.bin"));
      return;
    }
    const sig = mode === "badsig" ? plausibleButWrongSignature() : realSig;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(manifest(sig));
    return;
  }

  if (url.pathname === "/serious-updater-probe.bin") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(signedDummy.payload.length),
    });
    res.end(signedDummy.payload);
    return;
  }

  if (url.pathname.endsWith(".exe")) {
    res.writeHead(200, {
      "content-type": "application/vnd.microsoft.portable-executable",
      "content-length": String(installerSize),
    });
    const stream = createReadStream(installer);
    if (throttleInstaller) {
      // Hand out the file in slow slices. The download never completes during
      // the progress assertions, so the installer is never launched.
      stream.on("data", (chunk) => {
        stream.pause();
        bytesServed += chunk.length;
        res.write(chunk);
        setTimeout(() => stream.resume(), 120);
      });
      stream.on("end", () => res.end());
    } else {
      stream.on("data", (chunk) => {
        bytesServed += chunk.length;
      });
      stream.pipe(res);
    }
    downloadSockets.push(res);
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
console.log(`local update channel at ${ORIGIN} (mode=${mode})`);

// The key-pair question, answered before anything else.
const chain = await verifySignatureChain();
console.log(
  `pubkey/sig: key id ${chain.keyId} · primary(artifact) ${chain.primaryOk ? "VERIFIES" : "FAILS"}` +
    ` · trusted comment (global sig, ${chain.globalForm ?? "no matching form"}) ` +
    `${chain.globalOk ? "VERIFIES" : "FAILS"}`,
);
console.log(`  trusted comment: ${chain.trustedComment}`);

// ---------------------------------------------------------------------------
// Drive the packaged app
// ---------------------------------------------------------------------------
// Every `cargo build` rewrites the exe, which resets its integrity label to
// Low — and a Low-integrity binary makes WebView2 fail to create its window
// with "灾难性故障" (HRESULT 0x8000FFFF). Set it here so a rebuild between runs
// cannot masquerade as a product failure.
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync("icacls", [exe, "/setintegritylevel", "Medium"], { stdio: "ignore" });
} catch (e) {
  console.warn(`  (could not set integrity level: ${e.message})`);
}

const profile = await mkdtemp(path.join(os.tmpdir(), "upd-profile-"));
const cdpPort = 19493;
const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

const lines = [];
const record = (s) => {
  console.log(s);
  lines.push(s);
};

let browser = null;
let failed = false;
const results = [];

try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the app never opened its CDP port");
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1000 });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 20000 }));
  await page.waitForSelector(".sidebar", { timeout: 20000 });

  const version = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("current_version"),
  );
  record(`app version: ${version}`);
  results.push({ case: "baseline", observed: `current_version=${version}` });
  results.push({
    case: "pubkey-vs-artifact-signature",
    observed:
      `key id ${chain.keyId}; artifact signature ${chain.primaryOk ? "VERIFIES" : "FAILS"}; ` +
      `trusted comment ${chain.trustedComment}`,
  });
  if (!chain.primaryOk || !chain.globalOk) {
    throw new Error(
      "the configured pubkey does not match the key that signed the local artifact",
    );
  }

  // The banner renders only on the library view, so both install cases must run
  // here, before the settings panel is opened. It appears about 3s after launch
  // (measured separately by update-banner-probe.mjs).
  const bannerLoc = page.locator(".banner").first();
  const bannerAppeared = await bannerLoc
    .waitFor({ timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  record(
    `startup banner present: ${bannerAppeared}` +
      (bannerAppeared ? ` — "${(await bannerLoc.innerText()).replace(/\s+/g, " ").slice(0, 80)}"` : ""),
  );

  /** Click 检查更新 and return exactly what the user is shown. */
  async function check() {
    await page.locator(".main-body button", { hasText: "检查更新" }).click();
    const target = page.locator(".main-body").getByText(
      /还没有发布正式版本|已是最新版本|发现新版本|无法连接 GitHub|检查更新时出错/,
    );
    const found = await target
      .first()
      .waitFor({ timeout: 40000 })
      .then(() => true)
      .catch(() => false);
    if (!found) {
      // Nothing matched: capture whatever is on screen so the failure is legible.
      const body = (await page.locator(".main-body").innerText()).replace(/\s+/g, " ").slice(0, 300);
      return { text: body, colour: null, matched: false };
    }
    const el = target.first();
    return {
      text: (await el.innerText()).replace(/\s+/g, " "),
      colour: await el.evaluate((n) => getComputedStyle(n).color),
      title: await el.getAttribute("title"),
      matched: true,
    };
  }

  // The update banner is driven by the `update-available` event that the
  // backend emits once, ~1.5s after launch. Reloading the frontend does NOT
  // re-run that check, so the banner must be created once and reused — which is
  // why the whole sequence below runs without a single page.reload().

  // -- 2. a wrong signature must be refused -----------------------------------
  // The backend caches the manifest between the check and the install click
  // (PENDING). The startup check ran with the *good* manifest, so pressing the
  // banner's button now would install that one and launch the real NSIS
  // installer. Re-check with the tampered manifest first so the cache is
  // deterministic, then install.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForSelector("button:has-text('检查更新')", { timeout: 10000 });
  mode = "badsig";
  const badCheck = await check();
  record(`case badsig  -> check with tampered signature says: "${badCheck.text}"`);

  let sigError = null;
  if (bannerAppeared) {
    // Same command the banner's button calls, so the text is what a user sees.
    sigError = await page.evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("install_update");
        return "(install_update resolved — nothing was rejected)";
      } catch (e) {
        return String(e);
      }
    });
  }
  record(`case badsig  -> install result: ${sigError ?? "(no result)"}`);
  results.push({
    case: "badsig",
    observed: `check="${badCheck.text}"; install rejected with: ${sigError}`,
  });
  if (!sigError || !/失败|错误|拒绝|无效|签名|error|invalid|signature/i.test(sigError)) {
    throw new Error(`a tampered signature was not clearly refused: ${sigError}`);
  }

  // -- 3. download progress must actually move --------------------------------
  // Still on the library view, so the banner is on screen. A good manifest this
  // time; throttling keeps the transfer from finishing, so the real installer
  // is never launched. Progress is read from the bytes the channel has written.
  // The banner is only rendered outside the settings view, so go back first.
  await page.getByRole("button", { name: /书架/ }).first().click();
  await page.waitForTimeout(600);
  record(`banner back on the library view: ${await bannerLoc.count() > 0}`);
  throttleInstaller = true;
  downloadSockets = [];
  bytesServed = 0;
  const downloadStarted = (async () => {
    if (bannerAppeared) {
      const retryBtn = bannerLoc.locator("button", { hasText: /立即更新|重试/ });
      if ((await retryBtn.count()) > 0) await retryBtn.first().click();
    } else {
      await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("install_update").catch(() => null),
      );
    }
  })();

  const byteSamples = [];
  const textSamples = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(200);
    byteSamples.push(bytesServed);
    if (bannerAppeared) {
      const t = (await bannerLoc.innerText().catch(() => ""));
      const m = t.match(/([\d.]+)\s*\/\s*([\d.]+)\s*MB/);
      if (m) textSamples.push(`${m[1]}/${m[2]} MB`);
    }
  }
  await downloadStarted;
  record(
    `case download -> bytes served: ${byteSamples[0]} → ${byteSamples[byteSamples.length - 1]} ` +
      `(samples ${byteSamples.filter((_, i) => i % 4 === 0).join(", ")} of ${installerSize})`,
  );
  if (textSamples.length) record(`case download -> banner text: ${textSamples.join("  ")}`);
  results.push({
    case: "download",
    observed:
      `bytes ${byteSamples[0]} -> ${byteSamples[byteSamples.length - 1]} of ${installerSize}` +
      (textSamples.length ? `; banner ${textSamples.join(" ")}` : "; banner n/a"),
  });
  if (byteSamples[byteSamples.length - 1] <= byteSamples[0]) {
    throw new Error(
      `no bytes were transferred: ${byteSamples[0]} → ${byteSamples[byteSamples.length - 1]}`,
    );
  }
  // Never let the throttled download finish: it would launch a real installer.
  for (const s of downloadSockets) s.destroy?.();
  throttleInstaller = false;

  // -- 3b. a genuinely signed artifact must be ACCEPTED ----------------------
  // Rejecting a forged signature only shows the check is not a no-op. This
  // signs a small inert file with the real private key and serves it, so the
  // download completes and reaches verification. Anything other than a
  // signature complaint proves the verifier accepted it.
  if (signedDummy && !signedDummy.unavailable) {
    mode = "goodsig-probe";
    const acceptCheck = await check();
    record(`case goodsig -> check says: "${acceptCheck.text}"`);
    const acceptResult = await page.evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("install_update");
        return "(install_update resolved)";
      } catch (e) {
        return String(e);
      }
    });
    record(`case goodsig -> install result: ${acceptResult}`);
    results.push({
      case: "goodsig-accepted",
      observed: `signed with key id ${signedDummy.keyId}; check="${acceptCheck.text}"; install=${acceptResult}`,
    });
    const rejectedAsSignature = /invalid symbol|signature|签名|验签|verification/i.test(
      acceptResult,
    );
    if (rejectedAsSignature) {
      throw new Error(
        `the app rejected a correctly signed artifact: ${acceptResult}`,
      );
    }
  } else {
    record(`case goodsig -> SKIPPED (${signedDummy?.unavailable ?? "no signing key on this machine"})`);
    results.push({
      case: "goodsig-accepted",
      observed: `SKIPPED: ${signedDummy?.unavailable ?? "no signing key present"}`,
    });
  }

  // -- 1. a good manifest must be reported as a new version ------------------
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.waitForSelector("button:has-text('检查更新')", { timeout: 10000 });
  mode = "good";
  const good = await check();
  record(`case good    -> "${good.text}" (colour ${good.colour})`);
  results.push({ case: "good", observed: good.text });
  // Asserted against the derived version, so the check follows the app rather than
  // a literal that would quietly stop matching at the next release.
  if (!good.text.includes(`发现新版本 ${NEW_VERSION}`)) {
    throw new Error(`expected "发现新版本 ${NEW_VERSION}", saw "${good.text}"`);
  }

  // -- 4. endpoint error wording ---------------------------------------------
  for (const [name, nextMode, expect] of [
    ["notfound", "notfound", "还没有发布正式版本"],
    ["garbage", "garbage", "检查更新时出错"],
    ["offline", "online-off", "无法连接 GitHub"],
  ]) {
    if (nextMode === "online-off") {
      await new Promise((r) => server.close(r));
      record("  (local channel stopped listening)");
    } else {
      mode = nextMode;
    }
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.waitForSelector("button:has-text('检查更新')", { timeout: 10000 });
    const got = await check();
    record(`case ${name.padEnd(9)}-> "${got.text}" (colour ${got.colour})`);
    results.push({ case: name, observed: got.text });
    if (!got.text.includes(expect)) {
      throw new Error(`${name}: expected "${expect}", saw "${got.text}"`);
    }
  }

  record("");
  record("all update-channel cases behaved as expected");
} catch (error) {
  failed = true;
  record(`FAILED: ${error.message}`);
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  server.close();
}

await writeFile(
  path.join(outDir, "update-channel-test.log"),
  lines.join("\n") + "\n",
  "utf8",
);
await writeFile(
  path.join(outDir, "update-channel-test.json"),
  JSON.stringify(results, null, 2),
  "utf8",
);

process.exit(failed ? 1 : 0);