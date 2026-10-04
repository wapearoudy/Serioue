import { useEffect, useMemo, useState } from "react";

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

export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt="" />
    </div>
  );
}

/** Image grid with click-to-zoom. */
export function Gallery({ images }: { images: string[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const unique = useMemo(() => Array.from(new Set(images)), [images]);

  if (unique.length === 0) return null;
  return (
    <>
      <div className="gallery">
        {unique.map((src) => (
          <img key={src} src={src} alt="" loading="lazy" onClick={() => setZoom(src)} />
        ))}
      </div>
      {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
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