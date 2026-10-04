import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Settings } from "../api";

/** The four reading surfaces, in the order they are offered. */
export const THEMES: { key: string; label: string }[] = [
  { key: "dark", label: "夜间" },
  { key: "light", label: "白日" },
  { key: "sepia", label: "羊皮" },
  { key: "green", label: "护眼" },
];

type Props = {
  settings: Settings | null;
  onChange: (patch: Partial<Settings>) => void;
};

/**
 * Reading preferences, the controls a reader expects to find.
 *
 * Font size and line height are the two that matter most and are always
 * visible; the rest live behind the same popover to keep the header quiet.
 */
export function ReaderSettings({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!settings) return null;

  const fontSize = settings.reader_font_size;
  const lineHeight = settings.reader_line_height;

  const nudge = (key: "reader_font_size" | "reader_line_height", delta: number, min: number, max: number) =>
    onChange({ [key]: Math.max(min, Math.min(max, settings[key] + delta)) } as Partial<Settings>);

  return (
    <div className="reader-settings" ref={wrap}>
      <button
        className={open ? "on" : ""}
        onClick={() => setOpen((o) => !o)}
        title="阅读设置"
        aria-expanded={open}
      >
        Aa
      </button>

      {open && (
        <div className="reader-pop">
          <div className="reader-pop-row">
            <button onClick={() => nudge("reader_font_size", -1, 13, 30)} title="缩小字号">
              A-
            </button>
            <span className="reader-pop-value">{fontSize}px</span>
            <button onClick={() => nudge("reader_font_size", 1, 13, 30)} title="放大字号">
              A+
            </button>
          </div>

          <div className="reader-pop-row">
            <button onClick={() => nudge("reader_line_height", -10, 120, 240)} title="减小行距">
              行-
            </button>
            <span className="reader-pop-value">{(lineHeight / 100).toFixed(2)}</span>
            <button onClick={() => nudge("reader_line_height", 10, 120, 240)} title="增大行距">
              行+
            </button>
          </div>

          <div className="reader-pop-row">
            <span className="reader-pop-label">背景</span>
            {THEMES.map((t) => (
              <button
                key={t.key}
                className={settings.reader_theme === t.key ? "on" : ""}
                onClick={() => onChange({ reader_theme: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="reader-pop-row">
            <span className="reader-pop-label">字体</span>
            {[
              { key: "", label: "系统" },
              { key: "serif", label: "宋体" },
            ].map((f) => (
              <button
                key={f.key || "system"}
                className={settings.reader_font === f.key ? "on" : ""}
                onClick={() => onChange({ reader_font: f.key })}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="reader-pop-row">
            <span className="reader-pop-label">版心</span>
            {[0, 640, 760].map((w) => (
              <button
                key={w}
                className={settings.reader_width === w ? "on" : ""}
                onClick={() => onChange({ reader_width: w })}
              >
                {w === 0 ? "全宽" : `${w}`}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Apply reader preferences to the document.
 *
 * Kept out of the component so the same code works for the app shell and for
 * the reader preview page.
 */
export function applyReaderSettings(settings: Settings | null) {
  const root = document.documentElement;
  if (!settings) return;
  root.dataset.theme = settings.reader_theme || "dark";
  root.style.setProperty("--reader-size", `${settings.reader_font_size}px`);
  root.style.setProperty("--reader-line", String(settings.reader_line_height / 100));
  root.style.setProperty(
    "--reader-measure",
    settings.reader_width > 0 ? `${settings.reader_width}px` : "none",
  );
}

/** Load the stored preferences and apply them. Returns them for React state. */
export async function loadReaderSettings(): Promise<Settings> {
  try {
    const s = await api.getSettings();
    applyReaderSettings(s);
    return s;
  } catch (e) {
    // A missing settings file must not stop the reader from opening.
    console.warn("could not load reader settings", errorMessage(e));
    return null as unknown as Settings;
  }
}