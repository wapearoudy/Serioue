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

export function Banner({ text, onClose }: { text: string; onClose?: () => void }) {
  return (
    <div className="banner">
      <span style={{ flex: 1 }}>{text}</span>
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

/** A short glyph for content that has no thumbnail. */
export function kindGlyph(kind: string): string {
  switch (kind) {
    case "video":
      return "▶";
    case "image":
      return "🖼";
    case "novel":
      return "📖";
    default:
      return "📄";
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
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