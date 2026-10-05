// Development harness for the reading statistics panel.
//
// Mounts the real ReaderStatsPanel against a stubbed backend, so the panel can
// be driven with a known set of history and reading positions and the numbers
// on screen can be checked against what those inputs imply. Opened at
// /reader-stats-preview.html while `pnpm dev` runs; never bundled into a
// release.

import "./dev-tauri-stub";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReaderStatsPanel } from "./components/ReaderStatsPanel";
import "./styles.css";

function Preview() {
  const [open, setOpen] = useState(true);

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        {open ? (
          <ReaderStatsPanel onClose={() => setOpen(false)} />
        ) : (
          <>
            <div className="main-head">
              <div className="main-title">阅读统计预览</div>
              <span className="spacer" />
              <button onClick={() => setOpen(true)}>统计</button>
            </div>
            <div className="main-body">
              <div className="banner">
                统计面板已关闭，点击右上角「统计」重新打开。
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
