// Generates three short WAV tones under public/demo so the music player can be
// exercised in a real browser (Chromium plays WAV natively, no codec needed).
//
//   node scripts/make-demo-audio.mjs
//
// These are development fixtures only; they are not shipped in a release.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "demo");

/** 8-bit unsigned mono PCM at 8 kHz — tiny and loud enough to verify. */
function tone({ seconds = 1.2, hz = 440, rate = 8000 }) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    // A quick fade at both ends so the start/end is not a click.
    const edge = Math.min(1, i / 200, (samples - i) / 200);
    data[i] = Math.round(128 + 90 * edge * Math.sin((2 * Math.PI * hz * i) / rate));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

await mkdir(outDir, { recursive: true });

const tracks = [
  ["track-1.wav", { hz: 440, seconds: 1.5 }],
  ["track-2.wav", { hz: 554, seconds: 2.0 }],
  ["track-3.wav", { hz: 659, seconds: 1.2 }],
];

for (const [name, spec] of tracks) {
  await writeFile(path.join(outDir, name), tone(spec));
  console.log(`wrote public/demo/${name}`);
}