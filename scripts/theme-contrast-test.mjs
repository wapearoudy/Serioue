// Contrast check for the semantic colours of the four reading themes.
//
//   node scripts/theme-contrast-test.mjs
//
// Why this file exists: --ok / --warn / --err were only declared on `:root`,
// i.e. on the dark theme. `html[data-theme="light"|"sepia"|"green"]` never
// overrode them, so the three light themes inherited colours that were picked
// for a near-black background — error and warning text sat at 1.6:1–3.7:1 on
// them, which is why "保存失败" was practically invisible on 白日 / 羊皮 / 护眼.
//
// The palette is PARSED OUT OF src/styles.css. There is deliberately no second
// copy of the colours in here: a copy would be one more definition that can
// drift silently and still report success.
//
// What it checks, all four themes:
//   A. --ok / --warn / --err against --bg, --bg-elevated and --bg-hover
//      (>= 4.5:1, WCAG AA for body text). The three light themes must declare
//      their own values — inheriting the dark ones is the bug being guarded.
//   B. every rule that paints a semantic colour as a BACKGROUND: the colour
//      that sits on top of it (the rule's own `color`, or `inherit` = the
//      article text) must reach 4.5:1 over that background; translucent
//      backgrounds are composited over the page surfaces a notice can land on
//      (--bg, --bg-elevated). Rules with no foreground colour are indicators,
//      not text, and are held to the 3:1 of WCAG 1.4.11 instead.
//   C. text painted with a semantic colour and an `opacity` below 1: opacity
//      blends the text towards its own background, which lowers the real
//      contrast, so it is measured composited rather than at face value.
//
// Exits 0 when everything passes, 1 on the first batch of failures (all of them
// are printed, each naming theme, token, background, actual and required), 2 if
// the stylesheet cannot be understood at all (a renamed variable must be loud,
// not silently "no checks ran").

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = path.join(root, "src", "styles.css");

const TEXT_MIN = 4.5; // WCAG AA, normal text
const GRAPHIC_MIN = 3; // WCAG 1.4.11, non-text indicators
const THEMES = ["dark", "light", "sepia", "green"];
const LIGHT_THEMES = ["light", "sepia", "green"];
const SEMANTIC = ["ok", "warn", "err"];
const SURFACES = ["bg", "bg-elevated", "bg-hover"];
// Where a translucent tint can plausibly sit. --bg-hover is deliberately not
// one of them: it belongs to hovered rows and buttons, which never contain a
// banner or a note editor, and compositing over it would demand colours darker
// than the interface needs. Opaque text on a hovered surface is still covered,
// by group A.
const TINT_BASES = ["bg", "bg-elevated"];

// ---------------------------------------------------------------------------
// A very small CSS reader: enough for this stylesheet, and loud when it isn't.
// ---------------------------------------------------------------------------

/** Strip comments, keeping every other byte's offset identical. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Every `{ ... }` block, flattened, with the line its selector starts on. */
function parseRules(css) {
  const rules = [];
  const stack = [];
  let buf = "";
  let blockStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      stack.push({ selector: buf.trim(), at: i });
      buf = "";
      blockStart = i;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame && !frame.selector.startsWith("@") && frame.selector) {
        rules.push({
          selector: frame.selector,
          decls: parseDecls(buf),
          line: css.slice(0, frame.at).split("\n").length,
        });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (stack.length) throw new Error("unbalanced braces while reading src/styles.css");
  void blockStart;
  return rules;
}

function parseDecls(text) {
  const out = [];
  const push = (s) => {
    const t = s.trim();
    if (!t) return;
    const i = t.indexOf(":");
    if (i < 0) return;
    out.push([t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim()]);
  };
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const hex = (h) => {
  let s = h.slice(1);
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`cannot read hex colour "${h}"`);
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
    a: 1,
  };
};

function parseColorValue(value, theme, vars, depth = 0) {
  if (depth > 8) throw new Error(`variable cycle while resolving "${value}"`);
  const v = value.trim();

  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith("#")) return hex(v);

  const varRef = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (varRef) {
    const name = varRef[1];
    const decl = vars[name];
    if (decl === undefined) {
      if (varRef[2] !== undefined) return parseColorValue(varRef[2], theme, vars, depth + 1);
      throw new Error(`--${name.slice(2)} is not defined in ${theme}`);
    }
    return parseColorValue(decl, theme, vars, depth + 1);
  }

  const rgbRef = /^rgba?\(([^)]*)\)$/.exec(v);
  if (rgbRef) {
    const parts = rgbRef[1].split(/[,/]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) throw new Error(`cannot read colour "${v}"`);
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts.length > 3 ? Number(parts[3]) : 1,
    };
  }

  const mix = /^color-mix\(\s*in\s+srgb\s*,\s*([\s\S]+?)\s+([\d.]+)%\s*,\s*([\s\S]+?)(?:\s+([\d.]+)%)?\s*\)$/.exec(v);
  if (mix) {
    const a = parseColorValue(mix[1], theme, vars, depth + 1);
    const pa = Number(mix[2]) / 100;
    const b = parseColorValue(mix[3], theme, vars, depth + 1);
    const pb = mix[4] !== undefined ? Number(mix[4]) / 100 : 1 - pa;
    // CSS color-mix interpolates premultiplied, so transparent stays transparent.
    const alpha = a.a * pa + b.a * pb;
    if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (a.r * a.a * pa + b.r * b.a * pb) / alpha,
      g: (a.g * a.a * pa + b.g * b.a * pb) / alpha,
      b: (a.b * a.a * pa + b.b * b.a * pb) / alpha,
      a: alpha,
    };
  }

  throw new Error(`unsupported colour expression "${v}" (theme ${theme})`);
}

/** Alpha-composite `c` onto an opaque `base`. */
const over = (c, base, alpha = c.a) => ({
  r: c.r * alpha + base.r * (1 - alpha),
  g: c.g * alpha + base.g * (1 - alpha),
  b: c.b * alpha + base.b * (1 - alpha),
  a: 1,
});

/** WCAG relative luminance of an opaque colour. */
function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const show = ({ r, g, b }) =>
  `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

// ---------------------------------------------------------------------------
// Read the stylesheet
// ---------------------------------------------------------------------------

const raw = readFileSync(cssPath, "utf8");
const css = stripComments(raw);
const rules = parseRules(css);

const own = Object.fromEntries(THEMES.map((t) => [t, {}]));
for (const rule of rules) {
  const selectors = rule.selector.split(",").map((s) => s.trim());
  for (const theme of THEMES) {
    const sel =
      theme === "dark" ? ":root" : `html[data-theme="${theme}"]`;
    if (selectors.includes(sel)) {
      for (const [prop, value] of rule.decls) {
        if (prop.startsWith("--")) own[theme][prop] = value;
      }
    }
  }
}

const vars = Object.fromEntries(
  THEMES.map((t) => [t, { ...own.dark, ...own[t] }]),
);

const problems = [];
const fail = (msg) => problems.push(msg);

// Structure first: a theme that quietly stops overriding a token is the defect
// this script exists for, and "nobody defines it, so everything inherits" must
// be an error rather than an empty check list.
for (const theme of LIGHT_THEMES) {
  for (const token of SEMANTIC) {
    if (own[theme][`--${token}`] === undefined) {
      fail(
        `html[data-theme="${theme}"] does not declare --${token}: it inherits the dark theme's value ` +
          `(--${token}: ${vars.dark[`--${token}`] ?? "?"}), which was picked for a dark background`,
      );
    }
  }
}
for (const theme of THEMES) {
  for (const name of ["--bg", "--bg-elevated", ...SEMANTIC.map((t) => `--${t}`)]) {
    if (vars[theme][name] === undefined) {
      fail(`${theme}: ${name} is not defined anywhere in src/styles.css`);
    }
  }
}
if (problems.length) {
  report(problems);
  console.error(
    `\ntheme-contrast: ${problems.length} problem(s) — the stylesheet cannot be checked as written.`,
  );
  process.exit(2);
}

const themeColor = (theme, name) =>
  parseColorValue(vars[theme][name], theme, vars[theme]);
const surface = (theme, name) => {
  const c = themeColor(theme, `--${name}`);
  return c.a === 1 ? c : over(c, { r: 255, g: 255, b: 255, a: 1 });
};

const surfaceColors = Object.fromEntries(
  THEMES.map((t) => [t, Object.fromEntries(SURFACES.map((s) => [s, surface(t, s)]))]),
);

// ---------------------------------------------------------------------------
// A. semantic colour as text on each surface
// ---------------------------------------------------------------------------

const rows = [];
for (const theme of THEMES) {
  for (const token of SEMANTIC) {
    for (const name of SURFACES) {
      const fg = themeColor(theme, `--${token}`);
      const bg = surfaceColors[theme][name];
      const ratio = contrast(fg.a === 1 ? fg : over(fg, bg), bg);
      rows.push({ theme, token, name, ratio });
      if (ratio < TEXT_MIN) {
        fail(
          `${theme}: --${token} ${show(fg)} on --${name} ${show(bg)} = ${ratio.toFixed(2)}:1, need >= ${TEXT_MIN}:1`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// B. semantic colour as a background, and what sits on it
// ---------------------------------------------------------------------------

const bgSites = [];
for (const rule of rules) {
  const paint = rule.decls.filter(
    ([prop, value]) =>
      (prop === "background" || prop === "background-color") &&
      /var\(--(ok|warn|err)\)/.test(value),
  );
  for (const [, value] of paint) {
    const declared = rule.decls.find(([prop]) => prop === "color");
    bgSites.push({ rule, value, declared: declared ? declared[1] : null });
  }
}

for (const site of bgSites) {
  const { rule, value, declared } = site;
  const where = `src/styles.css:${rule.line} (${rule.selector})`;
  for (const theme of THEMES) {
    const painted = parseColorValue(value, theme, vars[theme]);
    for (const name of TINT_BASES) {
      const base = surfaceColors[theme][name];
      const bg = painted.a === 1 ? painted : over(painted, base);
      if (declared === null) {
        // No colour of its own: a dot / indicator, not text. WCAG 1.4.11.
        const ratio = contrast(bg, base);
        if (!site.worst || ratio < site.worst.ratio) {
          site.worst = { ratio, theme, name, need: GRAPHIC_MIN, kind: "indicator" };
        }
        if (ratio < GRAPHIC_MIN) {
          fail(
            `${theme}: ${where} paints ${value} = ${show(bg)} on --${name} ${show(base)} = ` +
              `${ratio.toFixed(2)}:1, need >= ${GRAPHIC_MIN}:1 for a non-text indicator`,
          );
        }
        continue;
      }
      const fgRaw =
        declared === "inherit"
          ? vars[theme]["--text"]
          : declared;
      const fg = parseColorValue(fgRaw, theme, vars[theme]);
      const ratio = contrast(fg.a === 1 ? fg : over(fg, bg), bg);
      if (!site.worst || ratio < site.worst.ratio) {
        site.worst = { ratio, theme, name, need: TEXT_MIN, kind: "text" };
      }
      if (ratio < TEXT_MIN) {
        fail(
          `${theme}: ${where} puts color: ${declared} = ${show(fg)} on background ${value} = ` +
            `${show(bg)} (over --${name}) = ${ratio.toFixed(2)}:1, need >= ${TEXT_MIN}:1`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// C. semantic colour as text under `opacity`
// ---------------------------------------------------------------------------

const dimSites = [];
for (const rule of rules) {
  const dim = rule.decls.find(([prop]) => prop === "opacity");
  if (!dim) continue;
  const alpha = Number(dim[1]);
  if (!Number.isFinite(alpha) || alpha >= 1) continue;
  const paint = rule.decls.find(
    ([prop, value]) => prop === "color" && /var\(--(ok|warn|err)\)/.test(value),
  );
  if (paint) dimSites.push({ rule, alpha, value: paint[1] });
}

for (const site of dimSites) {
  const { rule, alpha, value } = site;
  const where = `src/styles.css:${rule.line} (${rule.selector})`;
  for (const theme of THEMES) {
    const fg = parseColorValue(value, theme, vars[theme]);
    for (const name of TINT_BASES) {
      const base = surfaceColors[theme][name];
      const dimmed = over(fg, base, alpha * fg.a);
      const ratio = contrast(dimmed, base);
      if (!site.worst || ratio < site.worst.ratio) {
        site.worst = { ratio, theme, name, need: TEXT_MIN, kind: "text" };
      }
      if (ratio < TEXT_MIN) {
        fail(
          `${theme}: ${where} shows color: ${value} at opacity ${alpha} = ${show(dimmed)} on --${name} ` +
            `${show(base)} = ${ratio.toFixed(2)}:1, need >= ${TEXT_MIN}:1`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(list) {
  for (const p of list) console.error(`  FAIL ${p}`);
}

const w = (s, n) => String(s).padEnd(n);
console.log(`theme-contrast: parsing ${path.relative(root, cssPath)} (${raw.split("\n").length} lines)`);
console.log("");
console.log(`${w("theme", 7)}${w("token", 7)}${w("on", 15)}${w("colour", 22)}${w("ratio", 8)}need`);
for (const r of rows) {
  const name = `--${r.name}`;
  const value = vars[r.theme][`--${r.token}`];
  const flag = r.ratio < TEXT_MIN ? "  <-- FAIL" : "";
  console.log(
    `${w(r.theme, 7)}${w(`--${r.token}`, 7)}${w(name, 15)}${w(value, 22)}${w(r.ratio.toFixed(2), 8)}${TEXT_MIN}${flag}`,
  );
}
console.log("");
console.log(
  `${rows.length} semantic pairs, minimum ${Math.min(...rows.map((r) => r.ratio)).toFixed(2)}:1 (need >= ${TEXT_MIN}:1)`,
);
console.log("");
console.log("foreground sitting on a semantic-coloured background (worst theme/surface per rule):");
for (const site of [...bgSites, ...dimSites]) {
  const { rule, value, worst } = site;
  if (!worst) continue;
  const fg =
    site.declared === undefined
      ? `${value} @ opacity ${site.alpha}`
      : site.declared === null
        ? "(none: indicator)"
        : site.declared;
  console.log(
    `  ${w(`styles.css:${rule.line}`, 18)}${w(`${rule.selector.replace(/\s+/g, " ")}`.slice(0, 36), 38)}` +
      `${w(fg, 34)}on ${w(value, 52)}${w(`${worst.ratio.toFixed(2)}:1`, 9)}` +
      `need >= ${worst.need} (worst: ${worst.theme} / --${worst.name})`,
  );
}
console.log("");
console.log(
  `${bgSites.length} rule(s) paint a semantic colour as a background, ` +
    `${dimSites.length} dim one with opacity`,
);

if (problems.length) {
  console.error("");
  report(problems);
  console.error(`\ntheme-contrast: ${problems.length} failure(s).`);
  process.exit(1);
}
console.log("\ntheme-contrast: ok — every semantic colour is readable on all four themes.");
