import type { ReactNode } from "react";

export function Spinner() {
  return <div className="spinner" aria-label="加载中" />;
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

/**
 * A message above the content, optionally with something to do about it.
 *
 * `action` is not decoration: in an app whose sources fail intermittently, a
 * notice that can only be closed leaves the reader with no way forward except
 * fiddling with the page until the request happens to run again. Passing a retry
 * keeps the recovery where the error is.
 */
export function Banner({
  text,
  action,
  onClose,
}: {
  text: string;
  action?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="banner">
      <span style={{ flex: 1 }}>{text}</span>
      {action}
      {onClose && (
        <button className="ghost" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      )}
    </div>
  );
}

/** Compact relative time; falls back to an absolute date beyond a week. */
export function timeAgo(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const diff = Math.floor(Date.now() / 1000 - unixSeconds);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(unixSeconds * 1000).toLocaleDateString("zh-CN");
}

export function compactNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/** An inline SVG glyph for content that has no thumbnail.
 *
 * Vector, not emoji: 🖼/📖/📄 render from whatever font happens to be
 * installed, so they change weight, metrics and colour per machine and cannot
 * follow the theme tokens. These paths use `currentColor` and a single 1.8px
 * stroke, so they stay crisp and dim with `--text-faint` on every theme.
 * Music (♪) and video (▶) keep their text glyphs: they are single-codepoint
 * geometric shapes, not colour emoji, and already inherit the same colour.
 */
export function KindIcon({ kind, size = 22 }: { kind: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  if (kind === "image")
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="9" cy="10" r="1.6" />
        <path d="M4.5 18.5 10 13l3.5 3.5L17 13l2.5 2.5" />
      </svg>
    );
  if (kind === "novel")
    return (
      <svg {...common}>
        <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18v15.5H6.5A1.5 1.5 0 0 0 5 20Z" />
        <path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H18" />
        <path d="M9 8h6M9 11.5h6" />
      </svg>
    );
  // Navigation tiles: one 1.8px currentColor set, no emoji, no colour-meaning.
  if (kind === "verify")
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="7" />
        <path d="m16.5 16.5 4 4" />
        <path d="M8.5 11.5l2.2 2.2 3.8-4" />
      </svg>
    );
  if (kind === "history")
    return (
      <svg {...common}>
        <path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3" />
        <path d="M4.5 12H2.8M4.5 12V9.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    );
  if (kind === "shelf")
    return (
      <svg {...common}>
        <path d="M4 4.5v15M4 5h16M4 18.5h16" />
        <path d="M7 8.5h4M7 12h7" />
      </svg>
    );
  if (kind === "stats")
    return (
      <svg {...common}>
        <path d="M4 20V4M4 20h16" />
        <path d="M8.5 16v-5M13 16V8M17.5 16v-3" />
      </svg>
    );
  if (kind === "marks")
    return (
      <svg {...common}>
        <path d="M5 19.5 6.2 15 15.5 5.7a1.8 1.8 0 0 1 2.6 0l.2.2a1.8 1.8 0 0 1 0 2.6L9 17.8 5 19.5Z" />
        <path d="M13.8 7.4l2.8 2.8" />
      </svg>
    );
  if (kind === "settings")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M6 3.5h9L19.5 8v12.5h-13.5Z" />
      <path d="M14.5 3.5V8H19.5" />
      <path d="M9 12h6M9 15h6" />
    </svg>
  );
}

/** A short glyph for content that has no thumbnail.
 *
 * Kept for text-only contexts (aria labels, titles). The three colour-emoji
 * cases now answer geometric shapes that inherit the surrounding colour;
 * prefer <KindIcon/> for rendered output.
 */
export function kindGlyph(kind: string): string {
  switch (kind) {
    case "music":
      return "♪";
    case "video":
      return "▶";
    case "image":
      return "▦";
    case "novel":
      return "▤";
    default:
      return "▧";
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "music":
      return "音乐";
    case "video":
      return "视频";
    case "image":
      return "图集";
    case "novel":
      return "小说";
    default:
      return "文章";
  }
}