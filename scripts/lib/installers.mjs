// Picking "the" installer for the update legs.
//
// This is a one-liner that is wrong for years and then wrong quietly, so it lives
// in one place, as a pure function, with the two traps this repo has already paid
// for written down next to it.
//
//   1. `.sort().at(-1)` is a TEXT sort. `"Serious_0.1.10_x64-setup.exe"` sorts
//      BEFORE `"Serious_0.1.9_x64-setup.exe"`, because at the fourth character
//      `"1" < "9"`. So the moment the patch number reaches two digits the script
//      picks the OLDER installer and serves it as the newest — silently, because
//      nothing throws. The log made it worse by saying "using the newest": a wrong
//      answer that reports itself as right is the whole failure mode this team
//      keeps hitting.
//
//   2. Matching by *shape* is not matching by name. `sig-diagnose.mjs` looked for
//      `Serious_.*_setup\.exe`, but the real files carry a HYPHEN
//      (`Serious_0.1.3_x64-setup.exe`), so the pattern matched nothing and the
//      diagnostic announced "no installer" while the file sat in the directory.
//      Neither form throws. Both lie. That is why this module reports names it
//      could not read instead of dropping them.
//
// Run the self-test with:  node scripts/lib/installers.mjs

/** Does this file name look like one of our NSIS installers at all? */
export function looksLikeInstaller(name) {
  return /^Serious_.*setup\.exe$/i.test(name);
}

/**
 * The version inside the file name, as numbers, or null when there is none.
 *
 * Numeric on purpose: comparing "0.1.10" and "0.1.9" as numbers is the fix for
 * trap 1; comparing them as strings is the bug.
 */
export function parseInstallerVersion(name) {
  const m = /^Serious_(\d+(?:\.\d+)*)_/i.exec(name);
  if (!m) return null;
  return m[1].split(".").map(Number);
}

/** Component-wise, missing components count as 0: 0.1.10 > 0.1.9 > 0.1. */
export function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function formatVersion(version) {
  return version.join(".");
}

/**
 * The numerically newest installer among `names`.
 *
 * Returns `{ name, version, unparsed }`. `name` is null only when nothing could be
 * read; `unparsed` lists the file names that matched `looksLikeInstaller` but
 * carried no readable version, so a caller can say so rather than pretend they
 * were never there. Ties are broken by name, so the choice is deterministic.
 */
export function pickNewestInstaller(names) {
  const parsed = [];
  const unparsed = [];
  for (const name of names) {
    const version = parseInstallerVersion(name);
    if (version) parsed.push({ name, version });
    else unparsed.push(name);
  }
  if (parsed.length === 0) return { name: null, version: null, unparsed };
  parsed.sort((a, b) => compareVersions(b.version, a.version) || a.name.localeCompare(b.name));
  return { name: parsed[0].name, version: parsed[0].version, unparsed };
}

/**
 * What to say about the installer the bundle actually contains.
 *
 * A mismatch is a WARNING, never a failure, and the reason is structural rather
 * than a concession: the served version is a fixture (`<app>+1` has no build yet),
 * so the artifact being served is *expected* to be an older, real, signed bundle.
 * Every assertion in these legs reads the manifest for the version it reports and
 * the artifact bytes only for signature and download progress — none of them
 * depends on the artifact being the version the manifest claims. Failing here
 * would therefore not protect an assertion; it would delete the leg on every
 * machine that has not rebuilt a bundle for an unreleased version, which is the
 * one thing requirement "build it first" is supposed to avoid.
 *
 * What must not happen is the reader not knowing. So the mismatch is stated in
 * one line, with both numbers, every run.
 */
export function describeInstallerProvenance({ installerVersion, appVersion, servedVersion }) {
  const installer = formatVersion(installerVersion);
  if (installer === appVersion) {
    return {
      level: "same",
      message:
        `installer provenance: the bundle's installer is ${installer}, the same version ` +
        `tauri.conf.json claims (serving it as the ${servedVersion} update)`,
    };
  }
  return {
    level: "warning",
    message:
      `WARNING  installer provenance: the installer in the bundle is ${installer}, ` +
      `but tauri.conf.json says the app is ${appVersion} — this run serves it as the ` +
      `${servedVersion} update.\n` +
      `         WARNING, not a failure, on purpose: ${servedVersion} has no build yet, so the ` +
      `artifact is expected to be an older released bundle, and no assertion here reads its ` +
      `version (the UI wording comes from the manifest; only the signature and the download ` +
      `progress come from these bytes).\n` +
      `         rebuild if you need the two to agree: pnpm tauri build --bundles nsis`,
  };
}

// ---------------------------------------------------------------------------
// Self-test. Kept in the module so the thing that decides which installer to
// serve is the thing that proves it decides correctly; a separate test file
// would be one more place to forget.
// ---------------------------------------------------------------------------
function selfTest() {
  let failed = 0;
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
    console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    if (!ok) failed++;
  };

  // The headline case: two-digit patch numbers. This is the one that would have
  // shipped the older installer while the log said "the newest".
  const twoDigit = ["Serious_0.1.9_x64-setup.exe", "Serious_0.1.10_x64-setup.exe"];
  check("0.1.9 vs 0.1.10 picks 0.1.10", pickNewestInstaller(twoDigit).name, "Serious_0.1.10_x64-setup.exe");
  check("0.1.9 vs 0.1.10 picks 0.1.10 (order reversed)",
    pickNewestInstaller([...twoDigit].reverse()).name, "Serious_0.1.10_x64-setup.exe");
  // ...and the trap itself, asserted, so a future "simplification" back to a text
  // sort fails here rather than in a release.
  check("a text sort would have picked the OLDER one",
    [...twoDigit].sort().at(-1), "Serious_0.1.9_x64-setup.exe");

  // The bundle that is actually on disk today.
  const today = ["Serious_0.1.0_x64-setup.exe", "Serious_0.1.2_x64-setup.exe"];
  check("today's bundle picks 0.1.2", pickNewestInstaller(today).name, "Serious_0.1.2_x64-setup.exe");

  // And a future one, where both two-digit cases coexist.
  check("0.1.9 / 0.1.10 / 0.2.0 picks 0.2.0",
    pickNewestInstaller([...twoDigit, "Serious_0.2.0_x64-setup.exe"]).name,
    "Serious_0.2.0_x64-setup.exe");

  check("hyphenated name parses", parseInstallerVersion("Serious_0.1.3_x64-setup.exe"), [0, 1, 3]);
  // The version is read from the field right after `Serious_`, so the separator
  // before "setup" is not this function's business — an underscore there still
  // yields a usable version. The hyphen lesson below is about the GLOB, not this.
  check("the setup separator does not affect the version", parseInstallerVersion("Serious_0.1.3_x64_setup.exe"), [0, 1, 3]);
  check("no digits after the prefix -> no version", parseInstallerVersion("Serious_updater_x64-setup.exe"), null);
  check("the glob accepts both separators",
    [looksLikeInstaller("Serious_0.1.3_x64-setup.exe"), looksLikeInstaller("Serious_0.1.3_x64_setup.exe")], [true, true]);
  // Trap 2, asserted: the underscore-only form sig-diagnose.mjs used matched the
  // real file zero times, which is how it reported "no installer" with the file
  // sitting right there.
  check("an underscore-only setup glob matches the real file zero times",
    /^Serious_.*_setup\.exe$/i.test("Serious_0.1.3_x64-setup.exe"), false);
  check("a name with no version is reported, not dropped",
    pickNewestInstaller(["Serious_updater_x64-setup.exe", "Serious_0.1.2_x64-setup.exe"]),
    { name: "Serious_0.1.2_x64-setup.exe", version: [0, 1, 2], unparsed: ["Serious_updater_x64-setup.exe"] });
  check("nothing readable -> name null", pickNewestInstaller(["Serious_updater_x64-setup.exe"]).name, null);
  check("equal versions tie-break deterministically",
    pickNewestInstaller(["Serious_0.1.2_x64-setup.exe", "Serious_0.1.2_arm64-setup.exe"]).name,
    "Serious_0.1.2_arm64-setup.exe");
  check("compareVersions is numeric", compareVersions([0, 1, 10], [0, 1, 9]), 1);

  // The provenance wording, both directions.
  const warned = describeInstallerProvenance({ installerVersion: [0, 1, 2], appVersion: "0.1.3", servedVersion: "0.1.4" });
  check("mismatch is a WARNING naming both versions",
    warned.level === "warning" && warned.message.includes("installer in the bundle is 0.1.2") &&
      warned.message.includes("says the app is 0.1.3"), true);
  const same = describeInstallerProvenance({ installerVersion: [0, 1, 3], appVersion: "0.1.3", servedVersion: "0.1.4" });
  check("a matching installer is not a warning", same.level, "same");

  if (failed) {
    console.error(`\n${failed} self-test case(s) failed — the installer selection is not trustworthy`);
    process.exit(1);
  }
  console.log("\nall installer-selection self-test cases passed");
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/lib/installers.mjs");
if (invokedDirectly) selfTest();
