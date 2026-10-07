// In-app titlebar: brand, breadcrumb, and a drag region — not a fake OS bar.
//
// The native window frame stays exactly as it is (`decorations` untouched in
// tauri.conf.json): this bar gives the app a titlebar *look* (brand mark +
// current-source breadcrumb + external-link action) without gambling on
// frameless-window controls. The middle stretch carries
// `data-tauri-drag-region` so it becomes draggable the day decorations are
// turned off; until then it is simply layout. Window min/max/close stay
// native — no fake buttons that cannot actually drive the window.
//
// Props are strings, never components: the bar must render on every view
// (list, reader, panels) even when nothing is selected.

/** A small external-link glyph: vector, currentColor, 1.8px like KindIcon. */
function ExternalIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5" />
    </svg>
  );
}

export function Titlebar({
  crumb,
  sub,
  homeUrl,
}: {
  /** "源名 / 分类" or "阅读历史" etc. — what the main view is showing. */
  crumb: string;
  /** Second line: meta text (sourceMeta) or a hint. */
  sub?: string;
  /** When set, an external-link button opens the source site. */
  homeUrl?: string;
}) {
  return (
    <header className="titlebar" data-titlebar="1">
      <div className="titlebar-brand" aria-label="Serious">
        <span className="brand-mark" aria-hidden="true" />
        <span className="titlebar-name">Serious</span>
      </div>
      {/* Draggable the day decorations go frameless; harmless until then.
          Buttons inside must opt OUT of dragging, hence data-tauri-drag-region
          only here and not on the whole header. */}
      <div className="titlebar-drag" data-tauri-drag-region="1" aria-hidden="true" />
      <div className="titlebar-crumb">
        <h1 className="titlebar-title">{crumb}</h1>
        {sub && <div className="titlebar-sub">{sub}</div>}
      </div>
      {homeUrl && (
        <a href={homeUrl} target="_blank" rel="noreferrer" aria-label="在浏览器中打开源站">
          <button className="ghost titlebar-external" title="在浏览器中打开源站" tabIndex={-1}>
            <ExternalIcon />
          </button>
        </a>
      )}
    </header>
  );
}
