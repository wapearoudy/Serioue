// Development harness for the settings panel.
//
// Mounts the real SettingsPanel against a backend whose set_settings can be told
// to fail, and records what was actually stored, so the rollback, the success
// note, the retypeable number field and the range check can all be observed
// rather than assumed. Opened at /reader-settings-preview.html while `pnpm dev`
// runs; never bundled into a release.
//
//   ?failSave=1   every set_settings fails, so the rollback can be seen
//   ?slow=400     delay the write, so the in-between state is observable

import "./dev-tauri-stub";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel } from "./components/SettingsPanel";
import type { Settings } from "./api";
import "./styles.css";

const params = new URLSearchParams(location.search);
const FAIL_SAVE = params.get("failSave") === "1";
const SLOW = Number(params.get("slow")) || 0;

const INITIAL: Settings = {
  concurrent_checks: true,
  cache_enabled: false,
  repo_base: "https://www.yck2026.fun",
  user_agent: "",
  reader_font_size: 17,
  reader_line_height: 180,
  reader_font: "",
  reader_theme: "dark",
  reader_width: 0,
  player_volume: 0.8,
  player_rate: 1,
  render_js: false,
};

type Probe = { stored: Settings; writes: Settings[]; failures: number };
const probe: Probe = { stored: { ...INITIAL }, writes: [], failures: 0 };
(window as unknown as { __settingsProbe: Probe }).__settingsProbe = probe;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function installHarness() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } }).__TAURI_INTERNALS__;
  const base = internals.invoke as (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

  internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "get_settings":
        return { ...probe.stored };
      case "set_settings": {
        if (SLOW) await wait(SLOW);
        probe.writes.push({ ...(args.settings as Settings) });
        if (FAIL_SAVE) {
          probe.failures += 1;
          throw new Error("settings.json 写入失败：磁盘只读");
        }
        // Only what actually reached disk is remembered.
        probe.stored = { ...(args.settings as Settings) };
        return null;
      }
      case "list_collections":
        return [];
      case "data_dir":
        return "C:\\Users\\demo\\AppData\\Roaming\\serious";
      case "list_sources":
        return [];
      case "remove_sources":
        return 0;
      case "clear_cache":
        return 3;
      case "clear_cookies":
        return null;
      case "get_sources":
        return [];
      default:
        return base(cmd, args);
    }
  };
}

installHarness();

function Preview() {
  const [n, setN] = useState(0);
  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        <div className="main-head">
          <div className="main-title">
            设置页预览
            <span>写入次数 {n}</span>
          </div>
        </div>
        <SettingsPanel
          onSourcesChanged={() => setN((v) => v + 1)}
          onStatsChanged={() => {}}
          onClose={() => setN((v) => v + 1)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);