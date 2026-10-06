// The image gallery, measured in a real browser.
//
//   node scripts/gallery-test.mjs
//
// Needs `pnpm dev` running.
//
// The pictures are served by this script from a temporary HTTP server: three
// real PNGs (so `complete` and `naturalWidth` mean something) plus one URL that
// 404s, which is the only honest way to test the failed-image placeholder.
//
// What is asserted, and what is not: every claim is about the element — the
// `src` the <img> really has, its computed size, its alt text, whether the
// lightbox is still in the DOM, whether a control is disabled. Counting the
// words in a counter is never the whole assertion.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test-results");
const pageUrl = process.env.GALLERY_PREVIEW_URL || "http://localhost:1420/gallery-preview.html";

/** A flat PNG, big enough that fitting it to the window actually shrinks it. */
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      // A gradient, so "is this the next picture" is obvious to a human too.
      raw[p] = (rgb[0] + x) % 256;
      raw[p + 1] = (rgb[1] + y) % 256;
      raw[p + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", require_zlib().deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function require_zlib() {
  return zlib;
}
import zlib from "node:zlib";

// Deliberately larger than the 1100×900 test viewport, so "fitted to the
// window" and "at its natural size" are genuinely different things.
const pictures = [
  png(1600, 1200, [10, 40, 200]),
  png(1400, 1000, [200, 40, 10]),
  png(1200, 1600, [10, 200, 40]),
];
const names = ["one.png", "two.png", "three.png"];

const server = http.createServer((req, res) => {
  const name = (req.url || "").replace(/^\//, "");
  const at = names.indexOf(name);
  if (at < 0) {
    // The deliberately broken one: this is what a dead remote image looks like.
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": pictures[at].length });
  res.end(pictures[at]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const imageUrls = names.map((n) => `${base}/${n}`);
// The dead picture sits in the middle on purpose: paging has to keep working
// *past* a picture that will never load, which is the real-world case.
imageUrls.splice(2, 0, `${base}/missing.png`);
console.log(`  serving 3 pictures (and one 404) at ${base}`);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  // The bundled Chromium is not downloaded in this environment; the system Edge
  // is the same engine and is always present on Windows.
  channel: process.env.GALLERY_TEST_CHANNEL || "msedge",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let failed = false;

try {
  await page.goto(`${pageUrl}?images=${imageUrls.map(encodeURIComponent).join(",")}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await page.waitForSelector("[data-gallery-thumb]", { timeout: 15000 });

  // -- thumbnails are reachable and named -------------------------------------
  const thumbs = await page.evaluate(() =>
    [...document.querySelectorAll("[data-gallery-thumb]")].map((b) => ({
      tag: b.tagName,
      src: b.getAttribute("data-gallery-thumb"),
      alt: b.querySelector("img")?.getAttribute("alt") ?? null,
      label: b.getAttribute("aria-label"),
    })),
  );
  console.log(`  thumbnails: ${thumbs.length} · alts ${JSON.stringify(thumbs.map((t) => t.alt))}`);
  assert.equal(thumbs.length, 4, `expected 4 thumbnails, saw ${thumbs.length}`);
  assert.ok(
    thumbs.every((t) => t.tag === "BUTTON"),
    "a thumbnail is not a button, so the keyboard cannot reach it",
  );
  assert.deepEqual(
    thumbs.filter((t) => t.alt !== null).map((t) => t.alt),
    ["第 1 张 · 共 4 张", "第 2 张 · 共 4 张", "第 4 张 · 共 4 张"],
    `thumbnails have no useful alt text: ${JSON.stringify(thumbs.map((t) => t.alt))}`,
  );
  // The third never loads, so it has no <img> at all — but it must still be
  // announced, because a screen-reader user cannot see the placeholder.
  assert.equal(thumbs[2].alt, null, "the failed thumbnail still rendered an image element");
  assert.equal(
    thumbs[2].label,
    "打开第 3 张 · 共 4 张",
    `the failed thumbnail lost its accessible name: ${thumbs[2].label}`,
  );

  // -- a failed image says so, instead of leaving a silent gap -------------------
  await page.waitForSelector("[data-gallery-failed]", { timeout: 15000 });
  const failedText = (await page.locator("[data-gallery-failed]").innerText()).trim();
  console.log(`  the broken picture shows: "${failedText}"`);
  assert.match(failedText, /未能加载/, `the failed image says nothing: ${failedText}`);

  // -- keyboard: Tab reaches a thumbnail, Enter opens it ---------------------------
  await page.evaluate(() => document.querySelector("[data-gallery-thumb]").focus());
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, thumb: el?.getAttribute("data-gallery-thumb") ?? null };
  });
  console.log(`  focus lands on: ${focused.tag} ${focused.thumb}`);
  assert.equal(focused.tag, "BUTTON", "the thumbnail cannot take focus");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-lightbox-image]", { timeout: 5000 });
  console.log("  Enter on a focused thumbnail opens the lightbox");

  // -- paging -------------------------------------------------------------------
  const counter = (await page.locator("[data-lightbox-counter]").innerText()).trim();
  const firstSrc = await page.evaluate(
    () => document.querySelector("[data-lightbox-image]").getAttribute("src"),
  );
  console.log(`  opened on "${counter}", src=${firstSrc}`);
  assert.equal(counter, "第 1 / 4 张", `wrong starting position: ${counter}`);
  assert.ok(firstSrc.endsWith("/one.png"), `the lightbox shows the wrong picture: ${firstSrc}`);

  // The next picture is fetched before it is needed.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-lightbox-preload="1"][src$="/two.png"]');
      return !!el && el.complete && el.naturalWidth > 0;
    },
    null,
    { timeout: 10000 },
  );
  console.log("  the next picture is already loaded in the DOM before it is shown");

  // Keyboard paging, and the src really changes.
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.querySelector("[data-lightbox-counter]")?.textContent?.includes("第 2 / 4 张"),
    null,
    { timeout: 5000 },
  );
  const second = await page.evaluate(() => {
    const img = document.querySelector("[data-lightbox-image]");
    return { src: img.getAttribute("src"), alt: img.getAttribute("alt"), w: img.naturalWidth };
  });
  console.log(`  →  ${await page.locator("[data-lightbox-counter]").innerText()} · src=${second.src} · alt="${second.alt}" · naturalWidth=${second.w}`);
  assert.ok(second.src.endsWith("/two.png"), `ArrowRight did not change the picture (${second.src})`);
  assert.notEqual(second.src, firstSrc, "the counter moved but the image did not");
  assert.equal(second.alt, "第 2 张 · 共 4 张", "the open picture has no position in its alt text");

  // Paging onto a picture that will not load must say so and keep going.
  await page.keyboard.press("ArrowRight");
  await page.waitForSelector("[data-lightbox-failed]", { timeout: 10000 });
  const deadText = (await page.locator("[data-lightbox-failed]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  →  第 3 / 4 张 (the dead one) says: "${deadText}"`);
  assert.match(deadText, /missing\.png/, `the dead picture is not identified: ${deadText}`);

  await page.keyboard.press("ArrowRight");
  // Wait for the *image*, not the counter. The counter and the `src` are set in
  // the same render but the picture is preloaded, so there is a window where the
  // counter already reads 第 4 / 4 张 and the element still has no `src` — reading
  // `src` on the counter alone reports that window as "paging stopped". If paging
  // really does stop, this still fails; it just stops failing on the timing.
  await page.waitForFunction(
    () => {
      const src = document.querySelector("[data-lightbox-image]")?.getAttribute("src");
      return typeof src === "string" && src.endsWith("/three.png");
    },
    null,
    { timeout: 5000 },
  ).catch(async () => {
    const counter = await page
      .locator("[data-lightbox-counter]")
      .textContent()
      .catch(() => "(no counter)");
    const src = await page
      .locator("[data-lightbox-image]")
      .getAttribute("src")
      .catch(() => null);
    throw new Error(
      `paging stopped at the dead picture: src=${src}, counter=${counter?.trim()}`,
    );
  });
  const pastDead = await page.evaluate(
    () => document.querySelector("[data-lightbox-image]")?.getAttribute("src") ?? null,
  );
  console.log(`  →  past the dead picture: 第 4 / 4 张, src=${pastDead}`);
  assert.ok(pastDead?.endsWith("/three.png"), `paging stopped at the dead picture: ${pastDead}`);

  await page.keyboard.press("End");
  await page.waitForFunction(
    () => document.querySelector("[data-lightbox-counter]")?.textContent?.includes("第 4 / 4 张"),
    null,
    { timeout: 5000 },
  );
  const atEnd = await page.evaluate(() => ({
    next: document.querySelector("[data-lightbox-next]").disabled,
    prev: document.querySelector("[data-lightbox-prev]").disabled,
    src: document.querySelector("[data-lightbox-image]").getAttribute("src"),
  }));
  console.log(`  End → 第 4 / 4 张 · src=${atEnd.src} · next disabled=${atEnd.next} · prev disabled=${atEnd.prev}`);
  assert.equal(atEnd.next, true, "「下一张」 is live at the last picture");
  assert.equal(atEnd.prev, false, "「上一张」 is dead before the last picture");
  assert.ok(atEnd.src.endsWith("/three.png"), `End did not reach the last picture: ${atEnd.src}`);

  await page.keyboard.press("Home");
  await page.waitForFunction(
    () => document.querySelector("[data-lightbox-counter]")?.textContent?.includes("第 1 / 4 张"),
    null,
    { timeout: 5000 },
  );
  const atStart = await page.evaluate(() => ({
    prev: document.querySelector("[data-lightbox-prev]").disabled,
    next: document.querySelector("[data-lightbox-next]").disabled,
  }));
  console.log(`  Home → 第 1 / 4 张 · prev disabled=${atStart.prev} · next disabled=${atStart.next}`);
  assert.equal(atStart.prev, true, "「上一张」 is live on the first picture");
  assert.equal(atStart.next, false);

  // A disabled control really does nothing.
  const stillFirst = await page.evaluate(
    () => document.querySelector("[data-lightbox-image]").getAttribute("src"),
  );
  await page.locator("[data-lightbox-prev]").click({ force: true });
  await page.waitForTimeout(200);
  const afterDeadClick = await page.evaluate(
    () => document.querySelector("[data-lightbox-image]").getAttribute("src"),
  );
  assert.equal(afterDeadClick, stillFirst, "a disabled control still changed the picture");

  // -- zoom ---------------------------------------------------------------------
  const fitted = await page.evaluate(() => {
    const img = document.querySelector("[data-lightbox-image]");
    return {
      rendered: Math.round(img.getBoundingClientRect().width),
      natural: img.naturalWidth,
      readout: document.querySelector("[data-lightbox-zoom]").textContent.trim(),
    };
  });
  console.log(
    `  fitted: ${fitted.rendered}px on screen for a ${fitted.natural}px picture, zoom readout ${fitted.readout}`,
  );
  assert.ok(fitted.rendered < fitted.natural, "the picture is not fitted to the window at all");

  // A click on the picture zooms, and must NOT close the lightbox.
  await page.locator("[data-lightbox-image]").click();
  await page.waitForTimeout(250);
  const zoomed = await page.evaluate(() => {
    const img = document.querySelector("[data-lightbox-image]");
    return {
      stillOpen: !!document.querySelector(".lightbox"),
      rendered: Math.round(img.getBoundingClientRect().width),
      transform: getComputedStyle(img).transform,
      readout: document.querySelector("[data-lightbox-zoom]").textContent.trim(),
    };
  });
  console.log(
    `  after a click on the picture: lightbox still open=${zoomed.stillOpen}, ` +
      `${zoomed.rendered}px, transform=${zoomed.transform}, readout=${zoomed.readout}`,
  );
  assert.equal(zoomed.stillOpen, true, "clicking the picture closed the lightbox");
  assert.ok(zoomed.rendered > fitted.rendered, "clicking the picture did not zoom in");
  assert.notEqual(zoomed.readout, "100%", "there is no visible feedback about the zoom");

  // The wheel zooms too.
  await page.locator("[data-lightbox-stage]").hover();
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
  const wheeled = await page.evaluate(() => ({
    rendered: Math.round(document.querySelector("[data-lightbox-image]").getBoundingClientRect().width),
    readout: document.querySelector("[data-lightbox-zoom]").textContent.trim(),
  }));
  console.log(`  after a wheel-up: ${wheeled.rendered}px, readout=${wheeled.readout}`);
  assert.ok(wheeled.rendered > zoomed.rendered, "the wheel did not zoom");
  assert.equal(wheeled.readout, "230%", `unexpected zoom readout: ${wheeled.readout}`);

  // -- clicking the picture never closes; clicking the backdrop does -------------
  await page.screenshot({ path: path.join(outDir, "gallery-zoomed.png") });
  await page.locator("[data-lightbox-zoom-toggle]").click();
  await page.waitForTimeout(200);

  // Close it, reopen it, and test the two clicks separately.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".lightbox", { state: "detached", timeout: 5000 });
  await page.locator("[data-gallery-thumb]").first().click();
  await page.waitForSelector("[data-lightbox-image]", { timeout: 5000 });

  await page.locator("[data-lightbox-image]").click();
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator(".lightbox").count(),
    1,
    "clicking the picture closed the lightbox (the click bubbled to the backdrop)",
  );
  console.log("  a click on the picture leaves the lightbox open");

  // The backdrop: a corner, well away from the picture and the controls.
  await page.mouse.click(12, 12);
  await page.waitForSelector(".lightbox", { state: "detached", timeout: 5000 });
  assert.equal(await page.locator(".lightbox").count(), 0, "a backdrop click did not close it");
  console.log("  a click on the backdrop closes it");

  // -- a broken picture is explained in the lightbox too -------------------------
  await page.locator("[data-gallery-thumb]").nth(2).click();
  await page.waitForSelector("[data-lightbox-failed]", { timeout: 10000 });
  const lbFail = (await page.locator("[data-lightbox-failed]").innerText()).replace(/\s+/g, " ").trim();
  console.log(`  the lightbox on a dead picture says: "${lbFail}"`);
  assert.match(lbFail, /没能加载/, `the lightbox says nothing about the dead picture: ${lbFail}`);

  await page.screenshot({ path: path.join(outDir, "gallery.png"), fullPage: true });
  console.log("  screenshot: test-results/gallery.png");
} catch (error) {
  failed = true;
  console.error("gallery test failed:", error.message);
  try {
    await page.screenshot({ path: path.join(outDir, "gallery-failure.png"), fullPage: true });
    console.error("  failure screenshot: test-results/gallery-failure.png");
  } catch {
    /* ignore */
  }
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);