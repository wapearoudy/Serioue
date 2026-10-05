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
  // Long enough for a realistic lyric sheet to unfold, so "the current line
  // follows the song" is not a race against a 1.5-second file.
  ["track-1.wav", { hz: 440, seconds: 8.0 }],
  ["track-2.wav", { hz: 554, seconds: 2.0 }],
  ["track-3.wav", { hz: 659, seconds: 1.2 }],
];

for (const [name, spec] of tracks) {
  await writeFile(path.join(outDir, name), tone(spec));
  console.log(`wrote public/demo/${name}`);
}

// Lyric fixtures. The first is long on purpose, so the panel overflows and the
// follow-the-current-line behaviour is visible; the second is deliberately
// messy, because that is what real files look like. Lines are 0.4s apart, which
// is a normal singing pace.
const longLrc = [
  "[ti:第一首 · 测试音]",
  "[ar:演示合集]",
  "[al:演示合集]",
  "[by:make-demo-audio]",
  "[00:00.00]第一行歌词,用来检查高亮是否落在正确的时间点上",
  ...Array.from({ length: 18 }, (_, i) => {
    const t = (0.4 * (i + 1)).toFixed(2).padStart(5, "0");
    return `[00:${t}]第 ${i + 2} 行 · 用来把歌词面板撑到需要滚动`;
  }),
].join("\n");

const messyLrc = [
  "[ti:第二首 · 测试音]",
  "[00:00.50][00:01.00]同一行带两个时间戳",
  "[00:00:75]冒号也可以当小数点",
  "[offset:-500]",
  "这一行没有时间戳,应该被丢掉",
  "[00:01.60]",
  "[00:02.00]方括号 [在这里] 不该被当成时间戳",
].join("\n");

await writeFile(path.join(outDir, "track-1.lrc"), longLrc, "utf8");
console.log("wrote public/demo/track-1.lrc");
await writeFile(path.join(outDir, "track-2.lrc"), messyLrc, "utf8");
console.log("wrote public/demo/track-2.lrc");