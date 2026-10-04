// Generates a real multi-bitrate HLS stream under public/demo/hls so the video
// player can be tested end to end in a browser, offline.
//
//   node scripts/make-demo-video.mjs
//
// Uses ffmpeg's synthetic `testsrc` source, so no input media is needed.
// Produces a master playlist with three renditions — that is what exercises
// quality switching, not just playback.
//
// Development fixture only; never shipped in a release.

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "demo", "hls");

// Three renditions so the manifest carries real level metadata.
const LADDERS = [
  { name: "360p", width: 640, height: 360, bitrate: "500k" },
  { name: "720p", width: 1280, height: 720, bitrate: "1500k" },
  { name: "1080p", width: 1920, height: 1080, bitrate: "3000k" },
];

try {
  await run("ffmpeg", ["-version"]);
} catch {
  console.error("ffmpeg not found — cannot generate the demo stream");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const l of LADDERS) {
  const playlist = path.join(outDir, `${l.name}.m3u8`);
  console.log(`encoding ${l.name}…`);
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `testsrc=size=${l.width}x${l.height}:rate=24:duration=12`,
    "-f", "lavfi",
    "-i", `sine=frequency=${300 + LADDERS.indexOf(l) * 120}:duration=12`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-g", "48",
    "-c:a", "aac",
    "-b:a", "64k",
    "-hls_time", "4",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(outDir, `${l.name}-%03d.ts`),
    playlist,
  ], { maxBuffer: 1024 * 1024 * 32 });
}

// The master playlist the player actually loads. Each EXT-X-STREAM-INF must be
// immediately followed by its own URI — listing all the tags first makes the
// levels resolve to the wrong renditions.
const master = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  ...LADDERS.flatMap((l) => [
    `#EXT-X-STREAM-INF:BANDWIDTH=${Number(l.bitrate.slice(0, -1)) * 1000},RESOLUTION=${l.width}x${l.height},NAME="${l.name}"`,
    `${l.name}.m3u8`,
  ]),
  "",
].join("\n");

await (await import("node:fs/promises")).writeFile(path.join(outDir, "master.m3u8"), master);
console.log("wrote public/demo/hls/master.m3u8 with", LADDERS.length, "renditions");

// A WebVTT file so the player's subtitle path can be exercised for real.
const cues = [
  ["00:00:00.000", "00:00:03.000", "Serious 测试字幕"],
  ["00:00:03.000", "00:00:06.000", "第二行字幕"],
  ["00:00:06.000", "00:00:09.000", "第三行字幕"],
  ["00:00:09.000", "00:00:12.000", "最后一行字幕"],
];
const vtt = [
  "WEBVTT",
  "",
  ...cues.flatMap(([start, end, text]) => [`${start} --> ${end}`, text, ""]),
].join("\n");
await (await import("node:fs/promises")).writeFile(path.join(outDir, "subs.vtt"), vtt);
console.log("wrote public/demo/hls/subs.vtt with", cues.length, "cues");