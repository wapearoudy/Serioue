// Diagnostic: why does the artifact signature not verify while the global one does?
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", "Serious_0.1.2_x64-setup.exe");
const sigFile = `${installer}.sig`;

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