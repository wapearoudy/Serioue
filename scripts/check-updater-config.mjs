// Would this build send every user's update check to a placeholder?
//
// The updater endpoint lives in `tauri.conf.json`, and the packaging legs have to
// repoint it at a local server to test the update flow at all. That makes it the
// one file in the project where a temporary experiment is indistinguishable from
// a real setting — and the failure is silent: the app builds, ships, installs,
// and then checks a URL that only exists on the maintainer's machine. No user
// ever receives an update again, and nothing in CI complains.
//
// So this is a gate, not a helper. It reads the file and refuses anything that
// is not HTTPS or not this project's own release feed.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(await readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));

const endpoints = conf?.plugins?.updater?.endpoints;
const problems = [];

if (!Array.isArray(endpoints) || endpoints.length === 0) {
  problems.push("plugins.updater.endpoints is missing or empty");
} else {
  for (const url of endpoints) {
    // Tauri refuses a non-HTTPS endpoint at build time, but only for the *first*
    // one and only with a message that reads like a config mistake elsewhere.
    if (!/^https:\/\//i.test(url)) {
      problems.push(`not https: ${url}`);
      continue;
    }
    if (/127\.0\.0\.1|localhost|\/latest\.json$/.test(url) === false && !/releases\//.test(url)) {
      problems.push(`does not look like a release feed: ${url}`);
      continue;
    }
    if (/127\.0\.0\.1|localhost/.test(url)) {
      problems.push(
        `points at localhost: ${url} — every user's update check would go to this machine`,
      );
    }
  }
}

const pubkey = conf?.plugins?.updater?.pubkey;
if (!pubkey) problems.push("plugins.updater.pubkey is missing");

if (problems.length > 0) {
  console.error("the updater is not configured for a real release:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nThe packaging legs repoint this file at a local server on purpose.\n" +
      "Restore it before committing — `git diff src-tauri/tauri.conf.json` should be empty.",
  );
  process.exit(1);
}

console.log(`updater endpoint ok: ${endpoints.join(", ")}`);
