import { useEffect, useMemo, useRef, useState } from "react";

const VIDEO_EXT = /\.(m3u8|mp4|webm|ogg|mov|mkv)(\?|$)/i;

/** True when a URL points at something the browser can play directly. */
export function isPlayable(url: string): boolean {
  return VIDEO_EXT.test(url) || url.startsWith("blob:");
}

/**
 * HTML5 video player.
 *
 * HLS (`.m3u8`) is only natively supported on Safari, so on Chromium we fall
 * back to the `<video>` element with a clear hint rather than pretending to
 * play. That keeps behaviour honest instead of silently failing.
 */
export function VideoPlayer({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const hls = /\.m3u8(\?|$)/i.test(src);

  useEffect(() => {
    setErr(null);
  }, [src]);

  return (
    <div className="player-wrap">
      <video
        ref={ref}
        src={src}
        poster={poster}
        controls
        autoPlay={false}
        onError={() => setErr("视频无法播放：源可能已失效，或该格式不被内置播放器支持。")}
      />
      {hls && (
        <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-faint)" }}>
          这是 HLS (m3u8) 直播流。若无法播放，请在系统播放器或 VLC 中打开该链接。
        </div>
      )}
      {err && (
        <div style={{ padding: "8px 12px", fontSize: 12, color: "#f0a8a4" }}>{err}</div>
      )}
    </div>
  );
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