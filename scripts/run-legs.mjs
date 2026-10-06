// Runs the browser legs one at a time and records an exit code for each.
//
//   node scripts/run-legs.mjs                 # every registered leg
//   node scripts/run-legs.mjs music sleep     # just those
//
// Why this exists rather than a plain loop in a shell:
//
//   1. Concurrency. Launching every leg at once makes Edge instances fight over
//      resources; t14 measured two legs failing that way and both passing when
//      re-run alone. A false red sends someone off to change code that is fine,
//      so the legs go strictly one at a time, here.
//   2. The dev server dies. Port 1420 gets killed between runs and has been
//      killed many times. Its absence looks exactly like a broken build — every
//      leg fails with ERR_CONNECTION_REFUSED. So it is probed before *each*
//      leg, and the port's state is recorded next to that leg's result, so a
//      red can be attributed instead of guessed at.
//
// `test:update-channel` and `test:signature-accept` are skipped by default: both
// need the app rebuilt with a local update endpoint, so under a normal build they
// always report a configuration error that looks like a product fault.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");

/** Legs that need a specially-built app; never run them as part of the sweep. */
const NEEDS_SPECIAL_BUILD = new Set(["test:update-channel", "test:signature-accept"]);

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function run(entry) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("node", [path.join(root, "scripts", entry.script)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      out += c;
    });
    child.on("close", (code) => resolve({ code: code ?? -1, out, ms: Date.now() - started }));
  });
}

const pkg = JSON.parse(
  await import("node:fs").then((fs) => fs.promises.readFile(path.join(root, "package.json"), "utf8")),
);

let legs = Object.entries(pkg.scripts)
  .filter(([name, value]) => name.startsWith("test:") && value.startsWith("node scripts/"))
  .map(([name, value]) => ({ name, script: value.replace(/^node scripts\//, "") }))
  .filter(({ name }) => !NEEDS_SPECIAL_BUILD.has(name))
  .sort((a, b) => a.name.localeCompare(b.name));

const asked = process.argv.slice(2);
if (asked.length) {
  const want = new Set(asked.map((a) => (a.startsWith("test:") ? a : `test:${a}`)));
  legs = legs.filter((l) => want.has(l.name));
  if (!legs.length) {
    console.error(`no leg matched: ${[...want].join(", ")}`);
    console.error(`available: ${Object.keys(pkg.scripts).filter((k) => k.startsWith("test:")).join(" ")}`);
    process.exit(2);
  }
}

await mkdir(outDir, { recursive: true });
console.log(`running ${legs.length} leg(s), one at a time\n`);

const rows = [];
for (const leg of legs) {
  const up = await portOpen(1420);
  if (!up) {
    console.log(`!! port 1420 is not listening — skipping ${leg.name}`);
    console.log("   (every leg would fail with ERR_CONNECTION_REFUSED; start `pnpm dev` first)");
    rows.push({ leg: leg.name, exit: "SKIPPED", port1420: "down", ms: 0 });
    break;
  }
  process.stdout.write(`${leg.name.padEnd(22)} `);
  const { code, out, ms } = await run(leg);
  console.log(`exit=${code}  ${(ms / 1000).toFixed(1)}s`);
  rows.push({ leg: leg.name, exit: code, port1420: up ? "up" : "down", ms });
  await writeFile(
    path.join(outDir, "legs", `${leg.name.replace(/[^a-z0-9]+/gi, "-")}.log`),
    out,
    "utf8",
  ).catch(async () => {
    await mkdir(path.join(outDir, "legs"), { recursive: true });
    await writeFile(
      path.join(outDir, "legs", `${leg.name.replace(/[^a-z0-9]+/gi, "-")}.log`),
      out,
      "utf8",
    );
  });
}

const table = rows
  .map((r) => `${String(r.exit).padEnd(8)} ${r.leg.padEnd(22)} 1420=${r.port1420}  ${(r.ms / 1000).toFixed(1)}s`)
  .join("\n");
const failed = rows.filter((r) => r.exit !== 0 && r.exit !== "SKIPPED");
const summary =
  `\n${table}\n\n${rows.length} leg(s), ${failed.length} non-zero exit(s)` +
  (failed.length ? `: ${failed.map((r) => `${r.leg}=${r.exit}`).join(", ")}` : "");
console.log(summary);
await writeFile(path.join(outDir, "legs-summary.txt"), summary + "\n", "utf8");

process.exit(failed.length ? 1 : 0);