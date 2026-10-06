// Diagnostic: why does the artifact signature not verify while the global one does?
//
// Kept because it is what pinned down two things that are otherwise invisible:
// the public key in `tauri.conf.json` pairs with the signing key, and the
// artifact signature is over **BLAKE2b-512 of the file**, not the file's bytes
// (minisign's upper-case "ED" algorithm means prehashed). Getting that second one
// wrong makes every release look unsigned while the app itself installs fine.
//
// The installer is found by globbing rather than by naming a version: a path
// pinned to 0.1.2 would throw on 0.1.4 and be deleted before anyone noticed it
// had stopped working.
import { readFile, readdir } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
// The separator before "setup" is a hyphen in the real artefact
// (`Serious_0.1.3_x64-setup.exe`), so both spellings are accepted; matching only
// the underscore form finds nothing and reports a perfectly good release as
// having no installer at all.
const candidates = (await readdir(bundle).catch(() => [])).filter(
  (name) => /^Serious_.*[-_]setup\.exe$/i.test(name),
);
if (candidates.length === 0) {
  console.error(
    `no installer in ${bundle} — build one first: pnpm tauri build --bundles nsis\n` +
      "(with TAURI_SIGNING_PRIVATE_KEY set, or the .sig will not be produced)",
  );
  process.exit(1);
}
if (candidates.length > 1) {
  // Sorted as text, not as versions: this is a diagnostic, it says which file it
  // chose, and "0.1.9" > "0.1.10" lexically. Guessing a version order here would
  // be the exact kind of quiet wrongness this script exists to catch.
  console.log(`several installers present (${candidates.sort().join(", ")})`);
}
const installer = path.join(bundle, candidates.sort().at(-1));
const sigFile = `${installer}.sig`;
console.log(`installer       : ${path.basename(installer)}`);
if (!await readFile(sigFile).catch(() => null)) {
  console.error(`no .sig next to it (${path.basename(sigFile)}) — was it built signed?`);
  process.exit(1);
}

const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pubText = Buffer.from(conf.plugins.updater.pubkey.trim(), "base64").toString("utf8");
const pubB64 = pubText.trim().split("\n").pop().trim();
const pubRaw = Buffer.from(pubB64, "base64");
const key = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw.subarray(10, 42)]),
  format: "der",
  type: "spki",
});
console.log(`pubkey alg      : "${pubRaw.subarray(0, 2).toString("ascii")}"`);
console.log(`pubkey key id   : ${pubRaw.subarray(2, 10).toString("hex")}`);

const sigText = Buffer.from((await readFile(sigFile, "utf8")).trim(), "base64").toString("utf8");
const lines = sigText.trim().split("\n").map((l) => l.trim()).filter(Boolean);
const primaryBlob = Buffer.from(lines[1], "base64");
const globalSig = Buffer.from(lines[3], "base64");
const primarySig = primaryBlob.subarray(10, 74);

console.log(`primary alg     : "${primaryBlob.subarray(0, 2).toString("ascii")}"`);
console.log(`primary key id  : ${primaryBlob.subarray(2, 10).toString("hex")}`);
console.log(`key ids match   : ${primaryBlob.subarray(2, 10).equals(pubRaw.subarray(2, 10))}`);
console.log(`primarySig hex  : ${primarySig.subarray(0, 16).toString("hex")}…`);
console.log(`globalSig  hex  : ${globalSig.subarray(0, 16).toString("hex")}…`);

const artifact = await readFile(installer);
console.log(`artifact bytes  : ${artifact.length}`);

const comment = lines[2].replace(/^trusted comment:\s*/, "");
console.log(`global verifies over (primarySig||comment): ${
  crypto.verify(null, Buffer.concat([primarySig, Buffer.from(comment, "utf8")]), key, globalSig)
}`);

console.log(`primary verifies over artifact bytes      : ${crypto.verify(null, artifact, key, primarySig)}`);

// If tauri signed a digest rather than the raw bytes, try the common variants.
// minisign's "ED" (upper case) algorithm means *prehashed*: the signature is over
// BLAKE2b-512 of the content rather than the content itself.
for (const [name, data] of [
  ["blake2b-512(artifact)", crypto.createHash("blake2b512").update(artifact).digest()],
  ["sha512(artifact)", crypto.createHash("sha512").update(artifact).digest()],
  ["sha256(artifact)", crypto.createHash("sha256").update(artifact).digest()],
  ["sha384(artifact)", crypto.createHash("sha384").update(artifact).digest()],
]) {
  console.log(`primary verifies over ${name.padEnd(22)}: ${crypto.verify(null, data, key, primarySig)}`);
}