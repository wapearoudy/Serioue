import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export { isPlayable, VideoPlayer } from "./VideoPlayer";

/** One subtitle track found on a page. */
export type Subtitle = {
  src: string;
  label: string;
  lang: string;
  /** True when the source declares itself as the default track. */
  isDefault: boolean;
};

/**
 * Pull `<track kind="subtitles">` out of an article body.
 *
 * Video sites ship captions this way far more often than as a bare `.srt`
 * link, and a `<track>` the player never renders is a caption nobody sees.
 */
export function extractSubtitles(html: string, base: string): Subtitle[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: Subtitle[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("track").forEach((el) => {
    const kind = (el.getAttribute("kind") || "").toLowerCase();
    const raw = el.getAttribute("src");
    if (!raw || (kind && kind !== "subtitles" && kind !== "captions")) return;
    let src: string;
    try {
      src = new URL(raw, base).toString();
    } catch {
      src = raw;
    }
    if (seen.has(src)) return;
    seen.add(src);
    const lang = el.getAttribute("srclang") || el.getAttribute("lang") || "";
    const label = el.getAttribute("label") || lang || "字幕";
    out.push({ src, label, lang, isDefault: el.hasAttribute("default") });
  });
  return out;
}

/**
 * A picture at full size.
 *
 * The single-image form (`src`) is kept for callers that open one picture; pass
 * `images` + `index` to get a gallery the viewer can actually walk through,
 * because the whole point of a picture collection is moving through it without
 * going back to the grid each time.
 */
export function Lightbox({
  src,
  images,
  index = 0,
  onIndexChange,
  onClose,
  alt,
}: {
  src?: string;
  images?: string[];
  index?: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
  alt?: (index: number, total: number) => string;
}) {
  const list = images && images.length > 0 ? images : src ? [src] : [];
  const total = list.length;
  const at = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  const current = list[at];

  /**
   * Zoom, as a multiple of "fit the window". 1 is the fitted view the lightbox
   * opens in; anything above it means the viewer asked to see detail, which is
   * what a click on the picture is for.
   */
  const [scale, setScale] = useState(1);
  const [failed, setFailed] = useState(false);

  const go = useCallback(
    (next: number) => {
      if (total === 0 || !onIndexChange) return;
      onIndexChange(Math.min(Math.max(next, 0), total - 1));
    },
    [onIndexChange, total],
  );

  // A new picture starts fitted again: carrying a zoom across pictures is how
  // a viewer ends up staring at a corner of the next one.
  useEffect(() => {
    setScale(1);
    setFailed(false);
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (total < 2) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          go(at - 1);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(at + 1);
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(total - 1);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, go, onClose, total]);

  /**
   * Wheel zoom, attached natively because React's wheel listener is passive and
   * cannot stop the page scrolling behind the lightbox.
   */
  const wheelTarget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wheelTarget.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => {
        const next = s * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
        return Math.min(6, Math.max(0.4, Number(next.toFixed(3))));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!current) return null;

  const fitted = scale === 1;
  const label = (i: number) =>
    alt ? alt(i, total) : `第 ${i + 1} 张 · 共 ${total} 张`;
  const neighbours = [list[at - 1], list[at + 1]].filter(Boolean) as string[];

  return (
    <div
      className="lightbox"
      // Only the backdrop closes it. A click on the picture is the gesture for
      // looking closer, and a lightbox that closes when you try to look closer
      // is worse than one that never opened.
      onClick={onClose}
      style={{ cursor: fitted ? "zoom-out" : "grab" }}
      // It is a dialog, and a screen reader has to be told so: without these it
      // reads as another group of pictures on the page, with the controls in an
      // unknown place.
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      data-lightbox="1"
    >
      {/* Neighbours are fetched before they are needed: a few hundred kilobytes
          per picture is a visible stutter on every page turn otherwise. */}
      {neighbours.map((url) => (
        <img
          key={`preload-${url}`}
          data-lightbox-preload="1"
          src={url}
          alt=""
          aria-hidden="true"
          style={{ display: "none" }}
        />
      ))}

      <div
        ref={wheelTarget}
        data-lightbox-stage="1"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          maxWidth: "100%",
          maxHeight: "100%",
          overflow: "auto",
        }}
      >
        {failed ? (
          <div
            data-lightbox-failed="1"
            style={{ color: "#fff", fontSize: 14, padding: 24, textAlign: "center" }}
          >
            这张图片没能加载
            <br />
            <span style={{ fontSize: 12, opacity: 0.7, wordBreak: "break-all" }}>{current}</span>
          </div>
        ) : (
          <img
            data-lightbox-image="1"
            src={current}
            alt={label(at)}
            onClick={() => setScale((s) => (s === 1 ? 2 : 1))}
            onError={() => setFailed(true)}
            style={{
              cursor: fitted ? "zoom-in" : "zoom-out",
              maxWidth: fitted ? "94vw" : "none",
              maxHeight: fitted ? "94vh" : "none",
              objectFit: "contain",
              transform: scale === 1 ? undefined : `scale(${scale})`,
              transformOrigin: "center center",
            }}
          />
        )}
      </div>

      {/* Controls stop the click so pressing one does not close the lightbox. */}
      <div
        data-lightbox-bar="1"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          color: "#fff",
          fontSize: 12,
        }}
      >
        {total > 1 && (
          <>
            <button
              data-lightbox-prev="1"
              onClick={() => go(at - 1)}
              // Disabled at the ends rather than silently doing nothing: a control
              // that looks live and is not is a lie about the picture's position.
              disabled={at === 0}
              title="上一张 (←)"
              style={controlStyle}
            >
              ‹ 上一张
            </button>
            <span data-lightbox-counter="1" style={{ minWidth: 92, textAlign: "center" }}>
              第 {at + 1} / {total} 张
            </span>
            <button
              data-lightbox-next="1"
              onClick={() => go(at + 1)}
              disabled={at >= total - 1}
              title="下一张 (→)"
              style={controlStyle}
            >
              下一张 ›
            </button>
          </>
        )}
        {total > 1 && (
          <span style={{ opacity: 0.8 }} data-lightbox-zoom="1">
            {Math.round(scale * 100)}%
          </span>
        )}
        <button
          data-lightbox-zoom-toggle="1"
          onClick={() => setScale((s) => (s === 1 ? 2 : 1))}
          title="在适应窗口与原始尺寸之间切换"
          style={controlStyle}
        >
          {fitted ? "查看原始尺寸" : "适应窗口"}
        </button>
      </div>
    </div>
  );
}

const controlStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  color: "#fff",
  background: "rgba(0, 0, 0, 0.45)",
  border: "1px solid rgba(255, 255, 255, 0.35)",
  borderRadius: 6,
  cursor: "pointer",
};

/**
 * Image grid with a lightbox that can be walked through.
 *
 * The thumbnails are real buttons: a grid of `<img onClick>` can only be used
 * with a mouse, which leaves the whole feature unreachable by keyboard.
 */
export function Gallery({
  images,
  alt,
}: {
  images: string[];
  alt?: (index: number, total: number) => string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  /** URLs that failed, so the grid can say so instead of showing a silent gap. */
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const unique = useMemo(() => Array.from(new Set(images)), [images]);

  const label = (i: number) =>
    alt ? alt(i, unique.length) : `第 ${i + 1} 张 · 共 ${unique.length} 张`;

  if (unique.length === 0) return null;
  return (
    <>
      <div className="gallery">
        {unique.map((src, i) => (
          <button
            key={src}
            type="button"
            className="gallery-thumb"
            data-gallery-thumb={src}
            onClick={() => setOpen(i)}
            aria-label={`打开${label(i)}`}
            style={{
              display: "block",
              padding: 0,
              border: "1px solid var(--border, #333)",
              borderRadius: 6,
              overflow: "hidden",
              cursor: "pointer",
              background: "transparent",
            }}
          >
            {failed[src] ? (
              <span
                data-gallery-failed="1"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 72,
                  padding: 6,
                  fontSize: 11,
                  color: "var(--text-dim, #ccc)",
                  textAlign: "center",
                }}
              >
                图片未能加载
              </span>
            ) : (
              <img
                src={src}
                alt={label(i)}
                loading="lazy"
                onError={() => setFailed((prev) => ({ ...prev, [src]: true }))}
              />
            )}
          </button>
        ))}
      </div>
      {open !== null && (
        <Lightbox
          images={unique}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
          alt={alt}
        />
      )}
    </>
  );
}

/**
 * Pick images out of a rendered article body.
 *
 * We parse the HTML in an inert document so nothing executes while we scan.
 */
export function extractImages(html: string, base: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = new Set<string>();
  doc.querySelectorAll("img").forEach((img) => {
    const src =
      img.getAttribute("data-src") ||
      img.getAttribute("src") ||
      img.getAttribute("data-original") ||
      "";
    if (!src || src.startsWith("data:")) return;
    out.add(absolute(src, base));
  });
  return Array.from(out);
}

function absolute(url: string, base: string): string {
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * Sanitise article HTML before rendering it.
 *
 * Content comes from arbitrary third-party sites, so scripts, event handlers
 * and embedded frames are stripped. `<video>`/`<audio>`/`<img>` are kept
 * because they are the whole point of a media source.
 */
export function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script, style, link, meta, iframe, object, embed, form, noscript")
    .forEach((el) => el.remove());

  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  return doc.body.innerHTML;
}