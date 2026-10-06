#!/usr/bin/env python3
"""Serious logo master + multi-size export (t60).

Design: dark rounded square (#141a24 -> #0b0f17), neon gradient open-book /
S-shaped negative space (cyan #22d3ee -> violet #8b5cf6 -> magenta #f472b6),
crisp on light and dark themes (dark tile + bright glyph, no translucency).

Single source of truth: ICON_SVG below. PNG export uses Pillow only
(rasterised vector shapes, no resampling of the old icon). ICO is written by
Pillow (multi-size). ICNS is intentionally NOT regenerated here: this box has
no icns toolchain, so the old icon.icns is kept (see output note).

  python3 scripts/make-logo.mjs  # file keeps .mjs ext for the npm-script slot,
                                 # but runs under python3 (shebang); or:
  python3 scripts/make-logo.py   # same content, if your runner wants .py
"""
import math
import os
import struct
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("need Pillow: pip install Pillow", file=sys.stderr)
    sys.exit(1)

# Pillow >= 10 moved filters under Image.Resampling; stay compatible.
try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:
    RESAMPLE = Image.LANCZOS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "src-tauri", "icons")
SIZE = 512

# Neon stops along the glyph, top -> bottom.
STOPS = [
    (0.00, (34, 211, 238)),   # cyan
    (0.45, (129, 140, 248)),  # periwinkle
    (0.75, (139, 92, 246)),   # violet
    (1.00, (244, 114, 182)),  # magenta
]


def lerp(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def grad(t):
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t <= t1 or i == len(STOPS) - 2:
            f = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return lerp(c0, c1, max(0.0, min(1.0, f)))
    return STOPS[-1][1]


def rounded_tile(d, size, radius):
    # Vertical dark gradient tile.
    top = (26, 33, 46)
    bottom = (9, 13, 22)
    for y in range(size):
        c = lerp(top, bottom, y / max(1, size - 1))
        d.line([(0, y), (size, y)], fill=c)
    # Rounded corners via mask.
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def main():
    img = Image.new("RGB", (SIZE, SIZE), (11, 15, 23))
    d = ImageDraw.Draw(img)
    mask = rounded_tile(d, SIZE, radius=int(SIZE * 0.225))

    cx = SIZE / 2
    # Open-book glyph: two page quads meeting at a center spine, drawn as a
    # horizontal strip stack so the neon gradient flows top -> bottom.
    # Spine at cx, pages sweep out; top edge dips (book curve), bottom flares.
    half_w = SIZE * 0.32
    top_y = SIZE * 0.24
    bot_y = SIZE * 0.76
    strips = 64
    for i in range(strips):
        t0 = i / strips
        t1 = (i + 1) / strips
        tm = (t0 + t1) / 2
        y0 = top_y + (bot_y - top_y) * t0
        y1 = top_y + (bot_y - top_y) * t1
        # Book curve: pages narrower at the vertical middle (spine pinch).
        # Kept shallow so the glyph stays bold at 32px.
        pinch = 1.0 - 0.10 * math.sin(tm * math.pi)
        w = half_w * pinch
        # Slight S: left page leans up, right page leans down.
        lean = SIZE * 0.02 * math.sin(tm * math.pi)
        # Left page quad + right page quad, with a dark spine gap.
        gap = SIZE * 0.014
        c = grad(tm)
        d.polygon(
            [(cx - w, y0 - lean), (cx - gap, y0 * 0.98), (cx - gap, y1 * 1.0), (cx - w, y1 - lean)],
            fill=c,
        )
        d.polygon(
            [(cx + gap, y0 * 0.98), (cx + w, y0 + lean), (cx + w, y1 + lean), (cx + gap, y1 * 1.0)],
            fill=c,
        )
    # Spine highlight: thin bright line down the center.
    d.line([(cx, top_y * 0.99), (cx, bot_y)], fill=(240, 249, 255), width=max(3, SIZE // 170))
    # Soft top glow dot (reading spark).
    glow_r = SIZE * 0.045
    gx, gy = cx, top_y - SIZE * 0.055
    for r in range(int(glow_r), 0, -1):
        a = 1.0 - r / glow_r
        col = lerp((11, 15, 23), (165, 243, 252), a * 0.9)
        d.ellipse([gx - r, gy - r, gx + r, gy + r], fill=col)

    img.putalpha(mask)
    os.makedirs(ICONS, exist_ok=True)
    # Master 512.
    master = os.path.join(ICONS, "icon.png")
    img.save(master)
    print(f"wrote {master} ({os.path.getsize(master)} bytes)")
    # Downscaled sizes (high-quality resample from the 512 master).
    for name, px in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        p = os.path.join(ICONS, name)
        img.resize((px, px), RESAMPLE).save(p)
        print(f"wrote {p} ({os.path.getsize(p)} bytes)")
    # ICO multi-size from the master.
    ico = os.path.join(ICONS, "icon.ico")
    img.resize((256, 256), RESAMPLE).save(
        ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    print(f"wrote {ico} ({os.path.getsize(ico)} bytes)")
    print("kept icon.icns (no icns toolchain on this box)")


if __name__ == "__main__":
    main()
