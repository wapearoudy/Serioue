// Keyboard focus visibility on the four range sliders.
//
//   node scripts/focus-visible-test.mjs
//
// Needs `pnpm dev` running, with `pnpm demo:audio` and `pnpm demo:video`
// already generated.
//
// The four sliders under test:
//   music progress  .music-seek input[type=range]
//   music volume    .music-volume
//   video progress  .player-seek
//   video volume    .player-volume
//
// Every one of them is reached with a **real Tab key**. `element.focus()` does
// not take Chromium's `:focus-visible` path, which is precisely why a focus ring
// that only exists under `:focus-visible` can be missing for months: the obvious
// test (`.focus()` then read the style) passes while a keyboard user sees
// nothing.
//
// What is asserted:
//   1. the element really has `:focus-visible` after tabbing to it
//   2. the computed `outline` is a real ring — solid, >= 2px, offset > 0, opaque,
//      and the theme's own `--accent` (not a colour picked here)
//   3. a contrast ratio >= 3:1 (WCAG 1.4.11, non-text UI) for the indicator
//      against the surface that is actually behind it, which is worked out by
//      compositing the ancestor chain over both a white and a black base — for
//      the fullscreen video bar that chain is a 55%-black plate, so the video
//      frame behind it is the unknown and the two bases are its extremes
//   4. for the fullscreen bar, the real pixels of a screenshot: the ring must
//      be the accent colour where the computed style says it is, and some band
//      of the indicator must clear 3:1 against the pixels next to it. The
//      screen is the only place that can answer "can you see it", and a
//      screenshot is read back through a canvas here, so the numbers are
//      measured rather than inferred.
//
// Four themes are walked for all four sliders, and the fullscreen case is
// measured separately for two of them, with a screenshot kept for each.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const MUSIC_URL = process.env.MUSIC_PREVIEW_URL || "http://localhost:1420/music-preview.html";
const VIDEO_URL = process.env.VIDEO_PREVIEW_URL || "http://localhost:1420/video-preview.html";

/** WCAG minimum for a non-text UI indicator such as a focus ring. */
const MIN_CONTRAST = 3;

const THEMES = ["dark", "light", "sepia", "green"];
const MUSIC_SLIDERS = [
  { label: "音乐进度条", sel: ".music-seek input[type=range]" },
  { label: "音乐音量条", sel: ".music-volume" },
];
const VIDEO_SLIDERS = [
  { label: "视频进度条", sel: ".player-seek" },
  { label: "视频音量条", sel: ".player-volume" },
];

await mkdir(outDir, { recursive: true });

// -- colour maths ------------------------------------------------------------

const channel = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** `fg` at `alpha` over `bg`. */
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
const round = (rgb) => rgb.map((c) => Math.round(c));

/** `#abc`, `#aabbcc`, `rgb(…)`, `rgba(…)` -> `[r, g, b, a]`. */
function parseColor(text) {
  const s = String(text).trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const parts = m[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/** Paints a stack of translucent background layers (outermost first) on a base. */
function flatten(layers, base) {
  let out = base;
  for (const l of layers) out = over([l.r, l.g, l.b], l.a, out);
  return round(out);
}

const fmt = (rgb) => `rgb(${round(rgb).join(", ")})`;

// -- the page side -----------------------------------------------------------

/**
 * Everything about one slider, read from the live page.
 *
 * `backdropLayers` are the painted backgrounds from the root down to the
 * element's parent. The video is not one of them — it is a sibling, and that is
 * the whole difficulty of the fullscreen case; the two bases stand in for it.
 */
const READ = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const layers = [];
  let node = el.parentElement;
  const chain = [];
  while (node) {
    chain.push(node);
    node = node.parentElement;
  }
  chain.reverse();
  for (const n of chain) {
    const style = getComputedStyle(n);
    const c = parseCssColor(style.backgroundColor);
    if (!c || c[3] === 0) continue;
    layers.push({
      r: c[0],
      g: c[1],
      b: c[2],
      a: c[3],
      where: n.tagName.toLowerCase() + (n.className ? "." + String(n.className).split(" ")[0] : ""),
    });
  }
  /*
   * The layers from the element outwards up to and including the first
   * translucent one.
   *
   * `layers` stops at whatever ancestor is opaque, and in the fullscreen video
   * bar that ancestor is `.player-wrap`, which is painted black — but the film
   * is drawn *inside* it, as a sibling of the controls, so no ancestor walk can
   * ever see the frame the ring actually sits on. Stopping at the bar's own
   * translucent plate lets the caller paint that plate over the two extremes a
   * frame can be, which is the honest model of the surface.
   */
  const outward = [...layers].reverse();
  const plate = [];
  for (const l of outward) {
    plate.push(l);
    if (l.a < 1) break;
  }
  return {
    outlineStyle: cs.outlineStyle,
    outlineWidth: parseFloat(cs.outlineWidth) || 0,
    outlineOffset: parseFloat(cs.outlineOffset) || 0,
    outlineColor: cs.outlineColor,
    boxShadow: cs.boxShadow,
    focused: document.activeElement === el,
    focusVisible: el.matches(":focus-visible"),
    rect: {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      w: rect.width,
      h: rect.height,
    },
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    backdropLayers: layers,
    plateLayers: plate.reverse(),
  };

  function parseCssColor(text) {
    const m = String(text).match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const parts = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
};

const failures = [];
let phase = "";
async function check(name, fn) {
  phase = name;
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`FAIL  ${name}: ${error.message}`);
  }
}

const browser = await chromium.launch({
  channel: process.env.VIDEO_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

const read = (sel) => page.evaluate(READ, sel);

/** Sets the reading theme the way the app does. */
const setTheme = async (theme) => {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(60);
};

/**
 * Walks the page with the Tab key until every selector has been focused once.
 *
 * One pass over a freshly loaded page, so the tab order is the browser's own and
 * nothing is focused by script. Returns selector -> reading taken while focused.
 */
async function tabWalk(selectors, maxTabs = 90) {
  const found = new Map();
  for (let i = 0; i < maxTabs && found.size < selectors.length; i++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate((sels) => {
      const el = document.activeElement;
      if (!el || !el.matches) return null;
      return sels.find((s) => el.matches(s)) ?? null;
    }, selectors);
    if (hit && !found.has(hit)) found.set(hit, { tabs: i + 1, ...(await read(hit)) });
  }
  return found;
}

/** Loads a preview page at a theme and leaves the player calm. */
async function openPage(url, theme, { pauseVideo = false } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(url.includes("music") ? ".music" : ".player-wrap", { timeout: 25000 });
  await setTheme(theme);
  if (pauseVideo) {
    await page.evaluate(() => {
      const v = document.querySelector(".player-wrap video");
      v.loop = true;
      v.pause();
    });
    await page.waitForTimeout(120);
  }
}

/** Asserts one focused slider's indicator, and returns the numbers for the log. */
function judge(theme, label, before, focused, extra = []) {
  const key = `${theme} ${label}`;
  assert.ok(focused, `${key}: could not reach the slider with the Tab key at all`);
  assert.equal(
    focused.focusVisible,
    true,
    `${key}: reached after ${focused.tabs} tab(s) but :focus-visible did not match`,
  );
  assert.equal(focused.focused, true, `${key}: the element is not document.activeElement`);

  const unfocusedRing = `${before.outlineStyle} ${before.outlineWidth}`;
  assert.equal(
    before.outlineStyle,
    "none",
    `${key}: the unfocused slider already draws an outline (${unfocusedRing})`,
  );

  assert.equal(focused.outlineStyle, "solid", `${key}: outline-style is "${focused.outlineStyle}"`);
  assert.ok(
    focused.outlineWidth >= 2,
    `${key}: outline-width is ${focused.outlineWidth}px, needs at least 2px`,
  );
  assert.ok(focused.outlineOffset > 0, `${key}: outline-offset is 0, so the ring sits on the track`);
  const ring = parseColor(focused.outlineColor);
  assert.ok(ring && ring[3] === 1, `${key}: outline-color "${focused.outlineColor}" is not opaque`);

  const accent = parseColor(focused.accent);
  assert.ok(accent, `${key}: the theme has no --accent (${focused.accent})`);
  assert.ok(
    Math.abs(ring[0] - accent[0]) <= 2 &&
      Math.abs(ring[1] - accent[1]) <= 2 &&
      Math.abs(ring[2] - accent[2]) <= 2,
    `${key}: the ring is ${focused.outlineColor}, but the theme's --accent is ${focused.accent}`,
  );

  // The ring has to be visible against what is behind it, and every band of the
  // indicator is composited the same way, since a translucent shadow shows the
  // backdrop through it. The ancestor chain is composited over both a white and
  // a black base because a translucent plate makes the true backdrop
  // theme-dependent; a caller whose backdrop is not in the ancestor chain (the
  // fullscreen bar, whose film is a sibling) passes the extremes it wants judged.
  const bands = bandColors(focused, ring);
  const rows = [
    { label: "chain over white", backdrop: flatten(focused.backdropLayers, [255, 255, 255]) },
    { label: "chain over black", backdrop: flatten(focused.backdropLayers, [0, 0, 0]) },
    ...extra,
  ];
  for (const r of rows) {
    r.composited = bands.map((b) => ({
      what: b.what,
      inner: !!b.innerNearest,
      rgb: round(over(b.rgb, b.alpha ?? 1, r.backdrop)),
    }));
    r.best = r.composited.reduce(
      (acc, b) => {
        const c = contrast(b.rgb, r.backdrop);
        return c > acc.c ? { c, rgb: b.rgb, what: b.what } : acc;
      },
      { c: 0, rgb: null, what: "" },
    );
    r.inner = r.composited.find((b) => b.inner) ?? null;
    r.ringEdge = r.inner ? contrast(ring, r.inner.rgb) : Infinity;
  }

  const worst = rows.reduce((acc, r) => (r.best.c < acc.best.c ? r : acc), rows[0]);
  assert.ok(
    worst.best.c >= MIN_CONTRAST,
    `${key}: every band of the indicator is below ${MIN_CONTRAST}:1 against a ` +
      `${fmt(worst.backdrop)} surface (${worst.label}; best was ${worst.best.what} at ` +
      `${worst.best.c.toFixed(2)}:1; bands ` +
      `${bands.map((b, i) => `${b.what}=${fmt(rows[0].composited[i].rgb)}`).join(", ")})`,
  );
  const ringEdge = Math.min(...rows.map((r) => r.ringEdge));
  if (rows.some((r) => r.inner)) {
    assert.ok(
      ringEdge >= MIN_CONTRAST,
      `${key}: the accent ring only reaches ${ringEdge.toFixed(2)}:1 against the ` +
        `band next to it (${fmt(rows[0].inner.rgb)}), so the ring itself disappears`,
    );
  }
  return { rows, ring, bands, ringEdge };
}

/**
 * The colours the indicator is made of: the accent ring, plus every shadow band
 * that is not completely hidden underneath it.
 *
 * A shadow with spread `s` paints the region 0..s outside the border box, and
 * the ring covers `outline-offset` .. `outline-offset + outline-width` of that,
 * so a shadow is only part of the indicator when it reaches into the gap before
 * the ring or past the ring's outer edge. The band in that gap is the one the
 * ring has to stand out against.
 */
function bandColors(style, ring) {
  const ringInner = style.outlineOffset;
  const ringOuter = style.outlineOffset + style.outlineWidth;
  const shadows = [];
  const sh = style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : "";
  // Chromium: "rgba(0, 0, 0, 0.85) 0px 0px 0px 2px, rgba(255, 255, 255, 0.92) 0px 0px 0px 5px"
  const re = /(rgba?\([^)]*\))\s+([-\d.]+px)\s+([-\d.]+px)\s+([-\d.]+px)\s+([-\d.]+px)/g;
  let m;
  while ((m = re.exec(sh))) {
    const c = parseColor(m[1]);
    if (c) shadows.push({ rgb: c.slice(0, 3), alpha: c[3], spread: parseFloat(m[5]) });
  }
  shadows.sort((a, b) => a.spread - b.spread);

  const bands = [{ what: "outline ring", rgb: ring.slice(0, 3) }];
  for (const s of shadows) {
    const inGap = s.spread <= ringInner;
    const past = s.spread > ringOuter;
    if (!inGap && !past) continue; // entirely underneath the ring
    bands.push({
      what: `shadow ${s.spread}px`,
      rgb: s.rgb,
      alpha: s.alpha,
      spread: s.spread,
      inner: inGap,
      // The band that lives in the gap is the ring's immediate neighbour; when
      // there are several, the nearest one is the highest spread that fits.
      innerNearest: inGap && s.spread === Math.max(...shadows.filter((x) => x.spread <= ringInner).map((x) => x.spread)),
    });
  }
  return bands;
}

/**
 * The real pixels above one slider's top edge.
 *
 * A screenshot strip is handed back into the page, decoded through a canvas and
 * sampled column by column, so what is compared is the composited screen rather
 * than any style the test believes in.
 */
async function pixelColumn(sel, { rowsAbove = 10 } = {}) {
  const geo = await read(sel);
  const y0 = Math.max(0, Math.round(geo.rect.y) - rowsAbove);
  const height = Math.round(geo.rect.y) + 3 - y0;
  const clip = {
    x: Math.round(geo.rect.x + geo.rect.w / 2) - 2,
    y: y0,
    width: 4,
    height,
  };
  const shot = await page.screenshot({ clip });
  const rows = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const out = [];
    for (let y = 0; y < img.height; y++) {
      const d = ctx.getImageData(1, y, 1, 1).data;
      out.push([d[0], d[1], d[2]]);
    }
    return out;
  }, shot.toString("base64"));
  return { geo, y0, rows };
}

/** Judges a pixel column: the ring is where the style says, and it is visible. */
function judgePixels(label, geo, y0, rows, ring) {
  const topIndex = Math.round(geo.rect.y) - y0;
  const backdropRows = rows.slice(0, Math.max(1, topIndex - 6));
  const bandRows = rows.slice(Math.max(0, topIndex - 6), topIndex);
  const mean = (list) =>
    list.length === 0
      ? null
      : [0, 1, 2].map((i) => list.reduce((s, p) => s + p[i], 0) / list.length);
  const backdrop = mean(backdropRows);
  assert.ok(backdrop && bandRows.length > 0, `${label}: nothing to sample around the ring`);
  const isRing = (p) =>
    Math.abs(p[0] - ring[0]) <= 26 && Math.abs(p[1] - ring[1]) <= 26 && Math.abs(p[2] - ring[2]) <= 26;
  const ringRows = bandRows.filter(isRing);
  const best = bandRows.reduce(
    (acc, p) => {
      const c = contrast(p, backdrop);
      return c > acc.c ? { c, rgb: p } : acc;
    },
    { c: 0, rgb: bandRows[0] },
  );
  const profile = rows
    .map((p, i) => `${y0 + i}:${p.join(",")}`)
    .join(" ");
  return {
    backdrop,
    bandRows,
    ringRows,
    best,
    profile,
    topIndex,
    ringContrast: contrast(ring.slice(0, 3), backdrop),
  };
}

try {
  // -- 1. all four sliders, all four themes, by Tab key only ------------------
  for (const theme of THEMES) {
    await check(`[${theme}] 用 Tab 键走到四个滑杆，焦点指示可见`, async () => {
      for (const [url, sliders, pauseVideo] of [
        [MUSIC_URL, MUSIC_SLIDERS, false],
        [VIDEO_URL, VIDEO_SLIDERS, true],
      ]) {
        await openPage(url, theme, { pauseVideo });
        const before = new Map();
        for (const s of sliders) before.set(s.sel, await read(s.sel));
        const focused = await tabWalk(sliders.map((s) => s.sel));
        for (const s of sliders) {
          const result = judge(theme, s.label, before.get(s.sel), focused.get(s.sel));
          const f = focused.get(s.sel);
          // Both chain bases usually collapse to the same surface (the opaque
          // ancestor wins), so only distinct surfaces are worth printing.
          const seen = new Set();
          const line = result.rows
            .filter((r) => !seen.has(fmt(r.backdrop)) && seen.add(fmt(r.backdrop)) !== undefined)
            .map((r) => `${r.label} ${fmt(r.backdrop)} → best ${r.best.what} ${r.best.c.toFixed(2)}:1`)
            .join("; ");
          console.log(
            `  ${s.label}: ${f.tabs} tab(s), outline=${f.outlineStyle} ${f.outlineWidth}px ` +
              `${f.outlineColor} offset=${f.outlineOffset}px, ring vs inner band ` +
              `${result.ringEdge === Infinity ? "n/a" : result.ringEdge.toFixed(2) + ":1"}; ${line}`,
          );
        }
      }
    });
  }

  // -- 2. the fullscreen bar over a video frame -------------------------------
  // The case that cannot be judged from the stylesheet: the bar is a 55%-black
  // plate over whatever the film is showing, and the track is a 40%-white strip
  // on top of that. Measured in pixels, in two themes, with a screenshot kept.
  //
  // The window is made short and wide first so a 16:9 film fills the screen and
  // the transport really lies over the picture; in a 9:16-ish window the bar
  // sits below the film on the wrapper's black, and the pixels would say
  // nothing about a bright frame.
  const FILM_VIEW = { width: 1400, height: 700 };
  for (const theme of ["dark", "light"]) {
    await check(`[${theme}] 全屏控制条上的进度条焦点指示：computed + 实测像素`, async () => {
      await page.setViewportSize(FILM_VIEW);
      await openPage(VIDEO_URL, theme);
      await page.locator('.player-extras button[title*="全屏"]').click();
      await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
      await page.evaluate(() => document.querySelector(".player-wrap video").pause());
      await page.waitForTimeout(200);

      // The measurement only means something if the bar is lying on the film.
      const coverage = await page.evaluate(() => {
        const v = document.querySelector(".player-wrap video").getBoundingClientRect();
        const s = document.querySelector(".player-seek").getBoundingClientRect();
        return { filmBottom: Math.round(v.bottom), barTop: Math.round(s.top), covered: v.bottom >= s.top && v.top <= s.top };
      });
      assert.ok(
        coverage.covered,
        `全屏时影片没有铺到控制条下面（影片底 ${coverage.filmBottom} < 进度条顶 ${coverage.barTop}），` +
          `这一列的像素就说明不了明亮画面上的可见性`,
      );
      console.log(
        `  全屏几何：影片底边 ${coverage.filmBottom} 与进度条顶边 ${coverage.barTop} —— 控制条确实浮在画面上`,
      );

      // Tab from the fullscreen button (just clicked) into the transport.
      const beforeFs = await read(".player-seek");
      const focused = await tabWalk([".player-seek"], 40);
      const f = focused.get(".player-seek");
      // The two extremes the film can be behind the bar's 55% plate.
      const result = judge(theme, "全屏视频进度条", beforeFs, f, [
        { label: "bar plate over a white frame", backdrop: flatten(f.plateLayers, [255, 255, 255]) },
        { label: "bar plate over a black frame", backdrop: flatten(f.plateLayers, [0, 0, 0]) },
      ]);

      const px = await pixelColumn(".player-seek");
      const ring = parseColor(f.outlineColor);
      const judged = judgePixels(`[${theme}] 全屏视频进度条`, px.geo, px.y0, px.rows, ring);
      console.log(
        `  全屏 bar 的浮层 ${f.plateLayers.map((l) => `${l.where}=rgba(${l.r},${l.g},${l.b},${l.a})`).join(" + ")}` +
          `（视频是兄弟节点，祖先链看不到它，所以用两个极端帧代替）`,
      );
      for (const r of result.rows) {
        console.log(
          `    ${r.label} → backdrop ${fmt(r.backdrop)}, best ${r.best.what} ${r.best.c.toFixed(2)}:1, ` +
            `ring vs neighbour ${r.ringEdge === Infinity ? "n/a" : r.ringEdge.toFixed(2) + ":1"}`,
        );
      }
      console.log(`  实测像素列（格式 y:r,g,b）：${judged.profile}`);
      assert.ok(
        judged.ringRows.length > 0,
        `[${theme}] 全屏视频进度条: no pixel above the slider matches the ring colour ${f.outlineColor} ` +
          `(sampled ${judged.bandRows.length} rows, backdrop ${fmt(judged.backdrop)})`,
      );
      assert.ok(
        judged.best.c >= MIN_CONTRAST,
        `[${theme}] 全屏视频进度条: the brightest band of the indicator only reaches ` +
          `${judged.best.c.toFixed(2)}:1 against the measured backdrop ${fmt(judged.backdrop)}`,
      );
      console.log(
        `  实测 ${judged.ringRows.length} 个像素是 accent 环；环/背景 ${judged.ringContrast.toFixed(2)}:1，` +
          `最强的一条带 ${judged.best.c.toFixed(2)}:1（${fmt(judged.best.rgb)} vs ${fmt(judged.backdrop)}）`,
      );

      const name = `focus-fullscreen-${theme}.png`;
      await page.screenshot({ path: path.join(outDir, name) });
      console.log(`  screenshot: test-results/${name}`);
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
    });
  }

  // -- 3. the same slider out of fullscreen, as the contrast anchor -----------
  await check("[dark] 非全屏视频进度条：实测像素（对照组）", async () => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await openPage(VIDEO_URL, "dark", { pauseVideo: true });
    const beforeFs = await read(".player-seek");
    const focused = await tabWalk([".player-seek"], 40);
    const f = focused.get(".player-seek");
    judge("dark", "视频进度条", beforeFs, f);
    const px = await pixelColumn(".player-seek");
    const judged = judgePixels("[dark] 视频进度条", px.geo, px.y0, px.rows, parseColor(f.outlineColor));
    console.log(`  非全屏像素列：${judged.profile}`);
    assert.ok(judged.ringRows.length > 0, "[dark] non-fullscreen: the ring is not on screen");
    assert.ok(
      judged.best.c >= MIN_CONTRAST,
      `[dark] non-fullscreen: the indicator only reaches ${judged.best.c.toFixed(2)}:1 against ` +
        `${fmt(judged.backdrop)}`,
    );
    console.log(
      `  非全屏：环/背景 ${judged.ringContrast.toFixed(2)}:1，最强的一条带 ${judged.best.c.toFixed(2)}:1`,
    );
  });
} catch (error) {
  failures.push(`${phase || "setup"}: ${error.message}`);
  console.error(`${phase || "setup"} threw:`, error.message);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
} else {
  console.log("\nall checks passed");
}

process.exit(failures.length > 0 ? 1 : 0);
