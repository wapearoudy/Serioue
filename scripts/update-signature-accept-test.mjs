// The accept side of the update chain: does the app accept a signature that is
// genuinely valid?
//
//   node scripts/update-signature-accept-test.mjs
//
// Every other case in the chain is a *refusal* path: a forged signature, a 404,
// a malformed manifest, an unreachable host. Those can all pass while the
// verifier is broken in the direction that matters. If the configured pubkey and
// the signing key were mismatched, or the verifier hashed the wrong bytes, or the
// version in the manifest disagreed with the one the signature was bound to —
// every refusal test would still pass. Only an acceptance test can catch those.
//
// The artifact is signed with the real key by `tauri signer sign` (see
// scripts/sign-probe.ps1), so this is a genuine signature, not a self-rolled one.
//
// Telling "accepted" apart from "did nothing" needs more than "no error":
//
//   1. every byte of the artifact must actually have been served;
//   2. the call must reach a terminal outcome (resolved or rejected) rather than
//      hanging, which is what a silent no-op looks like;
//   3. no failure anywhere may name signature verification.
//
// A genuine acceptance then ends in a *launch* attempt, and the probe is a text
// file, so that attempt fails — with an error about running the file, never about
// the signature. The two are told apart by what the message is about, not by the
// presence of an error.
//
// Needs: the app built with the local channel endpoint, and the local
// certificate trusted (pwsh -File scripts/make-local-cert.ps1).

import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const sigDir = path.join(outDir, "signaccept");
const exe = path.join(root, "src-tauri", "target", "release", "serious.exe");
const PORT = 19555;
const ORIGIN = `https://127.0.0.1:${PORT}`;
// The manifest's version is derived from the app's own, never typed in. Pinning
// it means the next release either throws or — worse — keeps comparing a stale
// pair while printing "ok".
const tauriConf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const CURRENT_VERSION = tauriConf.version;
const [cMaj, cMin, cPatch] = CURRENT_VERSION.split(".").map(Number);
const NEW_VERSION =
  process.env.SERIOUS_FAKE_UPDATE_VERSION ?? `${cMaj}.${cMin}.${cPatch + 1}`;

// Two signatures over the *same* bytes, made by the real key, differing only in
// whether they are bound to a version. Both are valid; the point is to find out
// which one the app's verifier accepts, rather than guessing.
//
// Note these are produced by scripts/sign-probe.ps1, which signs with
// `--app-version <NEW_VERSION>`; if you override that version here, re-run the
// probe script so the two agree.
const ARTIFACTS = {
  // signed without --app-version: trusted comment is "timestamp:…\tfile:…"
  plain: { file: "probe.bin", name: "无版本绑定" },
  // signed with --app-version: trusted comment gains "version:<NEW_VERSION>"
  bound: { file: "probev.bin", name: `绑定版本 ${NEW_VERSION}` },
};

for (const { file } of Object.values(ARTIFACTS)) {
  const p = path.join(sigDir, file);
  if (!existsSync(p) || !existsSync(`${p}.sig`)) {
    console.error(
      `missing ${p}\nRun: pwsh -NoProfile -File scripts/sign-probe.ps1`,
    );
    process.exit(1);
  }
}
console.log(`app version ${CURRENT_VERSION}, serving ${NEW_VERSION} as the update`);

const payloads = {};
const signatures = {};
for (const [key, { file }] of Object.entries(ARTIFACTS)) {
  payloads[key] = await readFile(path.join(sigDir, file));
  signatures[key] = (await readFile(path.join(sigDir, `${file}.sig`), "utf8")).trim();
}

/** Valid base64, wrong content — the forged counterpart. */
function forgedSignature() {
  const junk = Buffer.alloc(64, 0x41).toString("base64");
  return `untrusted comment: signature from tauri secret key\n${junk}\n`;
}

await mkdir(outDir, { recursive: true });

// Preflight: this test only means anything against a build whose endpoint is
// this server. Against a normal build the app goes to GitHub, finds no release,
// and every case fails with "Could not fetch a valid release JSON" — which reads
// like a verifier problem and is not one. Say so up front instead.
// The endpoint is compiled in, so `tauri.conf.json` is only a hint that the
// build is the right one; the definitive check is the run itself.
const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const endpoints = conf?.plugins?.updater?.endpoints ?? [];
if (!endpoints.some((e) => e.includes(`127.0.0.1:${PORT}`))) {
  console.error(
    `this test needs an app built against ${ORIGIN}/latest.json\n` +
      `tauri.conf.json currently points at: ${JSON.stringify(endpoints)}\n` +
      `repoint it, rebuild, run this, then restore it — see the header of this file.`,
  );
  process.exit(1);
}

let mode = "plain";
let bytesServed = 0;

function manifest(signature, urlPath) {
  return JSON.stringify({
    version: NEW_VERSION,
    notes: "接受侧验证：真实签名。",
    pub_date: new Date("2026-01-15T10:00:00Z").toISOString(),
    platforms: { "windows-x86_64": { signature, url: `${ORIGIN}${urlPath}` } },
  });
}

const tls = {
  key: await readFile(path.join(root, "test-results", "local-cert", "key.pem")),
  cert: await readFile(path.join(root, "test-results", "local-cert", "cert.pem")),
};

const server = createHttpsServer(tls, (req, res) => {
  const p = new URL(req.url, ORIGIN).pathname;
  if (p === "/latest.json") {
    let sig;
    let which = "plain";
    if (mode === "reject") {
      sig = forgedSignature();
    } else if (mode === "bound") {
      sig = signatures.bound;
      which = "bound";
    } else {
      sig = signatures.plain;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(manifest(sig, `/artifact/${which}`));
    return;
  }
  if (p.startsWith("/artifact/")) {
    const which = p.split("/").pop();
    const body = payloads[which];
    res.writeHead(200, {
      "content-type": "application/vnd.microsoft.portable-executable",
      "content-length": String(body.length),
    });
    // Counted on 'finish' rather than before end(): that is the point at which the
// whole body actually went out, so a client that hung up early cannot make a
// partial download look complete.
res.on("finish", () => {
      bytesServed += body.length;
    });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});

// Every cargo build resets the integrity label to Low, and a Low-integrity binary
// makes WebView2 fail with "灾难性故障" (HRESULT 0x8000FFFF) — which looks like a
// product bug and is not one.
try {
  execFileSync("icacls", [exe, "/setintegritylevel", "Medium"], { stdio: "ignore" });
} catch (e) {
  console.warn(`  (could not set integrity level: ${e.message})`);
}

const profile = await mkdtemp(path.join(os.tmpdir(), "signaccept-"));
// Chosen because 19497 is held on some machines by an unrelated Tencent process
// (QQPCRTP) that comes back seconds after being killed — colliding with it stops
// the app from opening its debugging port and looks like a product fault.
const cdpPort = Number(process.env.SERIOUS_TEST_CDP_PORT || 19501);

// ─────────────────────────────────────────────────────────────────────────────
// House rule, binding on every test script in this repo:
//
//   A test script must never kill a process it did not start.
//
//   If a port is taken, do exactly one of these, in this order:
//
//     1. Move to another port. This is the right answer and usually enough —
//        19497 above is occupied by QQPCRTP, which is not ours, auto-restarts,
//        and is none of our business.
//     2. If no port works, let the test FAIL and print the name and path of
//        whatever holds the port, so a human can decide.
//     3. Never kill it, however much the error looks like "that process is the
//        problem". Deciding to end a process we did not start is the user's
//        call, not a test script's — the cost is not visible to us. Someone once
//        removed a Tencent process from someone's machine mid-session, it came
//        back on its own, and the only record of it was in a test log.
//
// `child` below is the one process this script owns, and killing it is correct.
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

const lines = [];
const results = [];
const record = (s) => {
  console.log(s);
  lines.push(s);
};

let browser = null;
let failed = false;

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
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForSelector(".sidebar", { timeout: 20000 });

  const version = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("current_version"),
  );
  record(`app version: ${version}`);

  /**
   * Check, then install, and describe what happened.
   *
   * `install_update` is the same command the banner's button calls, so the
   * string it rejects with is the string a user would see.
   */
  async function attempt(label) {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.waitForSelector("button:has-text('检查更新')", { timeout: 10000 });
    await page.locator(".main-body button", { hasText: "检查更新" }).click();
    const seen = await page
      .locator(".main-body")
      .getByText(/发现新版本|还没有发布正式版本|无法连接 GitHub|检查更新时出错/)
      .first()
      .waitFor({ timeout: 40000 })
      .then((e) => (e.innerText()).replace(/\s+/g, " "))
      .catch(() => "(no result line)");

    bytesServed = 0;
    const outcome = await page.evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("install_update");
        return { kind: "resolved", detail: "(install_update resolved)" };
      } catch (e) {
        return { kind: "rejected", detail: String(e) };
      }
    });
    // Give the server a moment to finish accounting the last chunks.
    await page.waitForTimeout(500);
    return { label, seen, ...outcome, bytesServed };
  }

  // -- the forged counterpart, for contrast --------------------------------
  mode = "reject";
  const bad = await attempt("forged signature");
  record(`case reject   -> check: "${bad.seen}"`);
  record(`case reject   -> install: ${bad.kind}: ${bad.detail}`);
  record(`case reject   -> bytes served: ${bad.bytesServed} of ${payloads.plain.length}`);
  results.push({
    case: "reject-forged",
    observed: `${bad.kind}: ${bad.detail}; ${bad.bytesServed} bytes`,
  });
  const badRejected = /invalid symbol|signature|签名|验签|verification/i.test(bad.detail);
  if (!badRejected) {
    throw new Error(`a forged signature was NOT rejected: ${bad.detail}`);
  }

  // -- both genuine signatures ----------------------------------------------
  // The refusal above and the acceptances below differ only in the signature.
  // Assert the outcome differs from the forged case: if a genuine signature
  // ended the same way, this test would pass while proving nothing.
  for (const which of ["plain", "bound"]) {
    mode = which;
    const got = await attempt(ARTIFACTS[which].name);
    record(`case accept/${which.padEnd(5)} (${ARTIFACTS[which].name}) -> install: ${got.kind}: ${got.detail}`);
    record(`case accept/${which.padEnd(5)} -> bytes served: ${got.bytesServed} of ${payloads[which].length}`);
    results.push({
      case: `accept-${which}`,
      observed: `${got.kind}: ${got.detail}; ${got.bytesServed} bytes`,
    });

    const signatureComplaint = /invalid symbol|signature|签名|验签|verification/i.test(
      got.detail,
    );
    if (signatureComplaint) {
      record(`   → the app REFUSED this genuine signature`);
      throw new Error(
        `${which}: the app rejected a correctly signed artifact: ${got.detail}`,
      );
    }
    if (got.bytesServed !== payloads[which].length) {
      throw new Error(
        `${which}: only ${got.bytesServed} of ${payloads[which].length} bytes were served, ` +
          `so the download never completed and acceptance was not actually proven`,
      );
    }
    if (got.detail === bad.detail) {
      // Both genuine signatures are expected to end in the *same* later error:
      // once verification passes, the plugin tries to run the file, and this
      // probe is not an installer. That shared ending is the point. What must
      // never happen is a genuine signature ending the way the forged one did.
      throw new Error(
        `${which}: the genuine signature produced the same outcome as the forged one ` +
          `("${got.detail}"), so this proves nothing`,
      );
    }
    record(`   → download completed, outcome differs from the forged case: accepted`);
  }

  record("");
  record("accept and reject sides both behaved as expected");
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
  path.join(outDir, "update-signature-accept-test.log"),
  lines.join("\n") + "\n",
  "utf8",
);
await writeFile(
  path.join(outDir, "update-signature-accept-test.json"),
  JSON.stringify(results, null, 2),
  "utf8",
);

process.exit(failed ? 1 : 0);