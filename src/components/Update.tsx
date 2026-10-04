import { useEffect, useState } from "react";
import {
  api,
  errorMessage,
  events,
  updateError,
  updateErrorDetail,
  updateNotice,
  type UpdateInfo,
  type UpdateNotice,
  type UpdateProgress,
} from "../api";

type Props = {
  /** Set when the backend reports an update at startup. */
  initial: UpdateInfo | null;
  onDismiss: () => void;
};

/** Which phase the updater is in. */
type Phase = "idle" | "downloading" | "installing" | "done" | "failed";

export function UpdateBanner({ initial, onDismiss }: Props) {
  const [info] = useState<UpdateInfo | null>(initial);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track backend download events.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    events
      .onUpdateProgress((p) => {
        setProgress(p);
        if (p.percent === 100) setPhase("installing");
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  if (!info) return null;

  async function install() {
    setPhase("downloading");
    setError(null);
    try {
      await api.installUpdate();
      // On success the installer takes over; this rarely returns.
      setPhase("done");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("failed");
    }
  }

  const busy = phase === "downloading" || phase === "installing";

  return (
    <div className="banner info" style={{ alignItems: "flex-start" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          发现新版本 {info.version}
          <span style={{ color: "var(--text-faint)", fontWeight: 400, marginLeft: 8 }}>
            当前 {info.current_version}
          </span>
        </div>

        {info.body && !updateError(info.body) && (
          <div
            style={{
              whiteSpace: "pre-wrap",
              maxHeight: 120,
              overflow: "auto",
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            {info.body.slice(0, 1200)}
          </div>
        )}

        {error && <div style={{ color: "#f0a8a4", marginBottom: 8 }}>{error}</div>}

        {busy && (
          <div style={{ maxWidth: 320, marginBottom: 8 }}>
            <div className="progress">
              <div style={{ width: `${progress?.percent ?? 3}%` }} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
              {phase === "installing"
                ? "正在安装…"
                : progress?.total
                  ? `${(progress.downloaded / 1048576).toFixed(1)} / ${(progress.total / 1048576).toFixed(1)} MB`
                  : "正在下载…"}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          {!busy && phase !== "done" && (
            <button className="primary" onClick={install}>
              {phase === "failed" ? "重试" : "立即更新"}
            </button>
          )}
          {!busy && (
            <button className="ghost" onClick={onDismiss}>
              稍后
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The block rendered inside the settings panel. */
export function UpdateSettings() {
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    api.currentVersion().then(setVersion).catch(() => {});
  }, []);

  async function check() {
    setChecking(true);
    setResult(null);
    setProblem(null);
    setNotice(null);
    setDetail(null);
    try {
      const info = await api.checkUpdate();
      const kind = updateNotice(info.body);
      if (kind) {
        setNotice(kind);
        setProblem(updateError(info.body));
        setDetail(updateErrorDetail(info.body));
      } else if (info.available) {
        setResult(`发现新版本 ${info.version}，重启应用后可在启动提示中更新。`);
      } else {
        setResult(`已是最新版本（${info.current_version}）。`);
      }
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  // "No release yet" is a normal state for an unpublished project; only a real
  // failure deserves the red treatment.
  const isProblem = notice !== "norelease";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
          当前版本 {version || "…"}
        </span>
        <button onClick={check} disabled={checking}>
          {checking ? "检查中…" : "检查更新"}
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-dim)" }}>{result}</div>
      )}
      {problem && (
        <div
          title={detail ?? undefined}
          style={{
            marginTop: 8,
            fontSize: 13,
            color: isProblem ? "#f0a8a4" : "var(--text-dim)",
          }}
        >
          {problem}
        </div>
      )}
    </div>
  );
}