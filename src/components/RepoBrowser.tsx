import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type RepoCollection } from "../api";
import { Banner, Empty, Spinner, compactNumber } from "./ui";
import { useDialogFocus } from "./focusTrap";

type Props = {
  onClose: () => void;
  onImported: () => void;
};

export function RepoBrowser({ onClose, onImported }: Props) {
  const [cols, setCols] = useState<RepoCollection[] | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  /** Bumped by 重试 to re-read the index of the page on screen. */
  const [indexToken, setIndexToken] = useState(0);
  /** The request that failed, so the retry repeats that one and not another. */
  const [retry, setRetry] = useState<(() => void) | null>(null);
  /**
   * The repository the user configured.
   *
   * The placeholder used to name one hard-coded site, so anyone who had moved
   * the repository to a mirror was still being taught an address that does not
   * answer. It now follows the setting.
   */
  const [repoBase, setRepoBase] = useState("");
  const dialog = useRef<HTMLDivElement>(null);

  useDialogFocus(dialog, onClose);

  useEffect(() => {
    api
      .repoBase()
      .then((base) => setRepoBase(base))
      .catch(() => {
        /* the placeholder falls back to the generic shape below */
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .repoIndex(page)
      .then((c) => {
        if (!cancelled) setCols(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        // Whatever just failed is what 重试 will repeat. Guessing here would
        // re-run the wrong request — importing a collection and listing the
        // index are not interchangeable.
        setRetry(() => () => {
          setIndexToken((t) => t + 1);
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, indexToken]);

  async function importOne(c: RepoCollection) {
    setImporting(c.id);
    setError(null);
    try {
      const res = await api.importFromUrl(c.json_url, c.title);
      setDone(`已导入「${c.title}」：新增 ${res.added} 个源，跳过 ${res.skipped} 个重复源`);
      onImported();
    } catch (err) {
      setError(errorMessage(err));
      setRetry(() => () => void importOne(c));
    } finally {
      setImporting(null);
    }
  }

  async function importCustom() {
    const url = customUrl.trim();
    if (!url) return;
    setCustomBusy(true);
    setError(null);
    try {
      const res = await api.importFromUrl(url);
      setDone(`已从链接导入：新增 ${res.added} 个源，跳过 ${res.skipped} 个重复源`);
      setCustomUrl("");
      onImported();
    } catch (err) {
      setError(errorMessage(err));
      // Keep the address, so the retry re-issues the same import instead of
      // making the reader paste it again.
      setRetry(() => () => void importCustom());
    } finally {
      setCustomBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 860 }}
        onClick={(e) => e.stopPropagation()}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-browser-title"
        tabIndex={-1}
        data-repo-dialog="1"
      >
        <h3 id="repo-browser-title">从源仓库导入合集</h3>

        {/* A success note is not an error and has nothing to retry. */}
        {done && <Banner text={done} onClose={() => setDone(null)} />}
        {error && (
          <Banner
            text={error}
            action={
              retry ? (
                <button
                  className="primary"
                  data-retry="repo"
                  aria-label="重试"
                  onClick={() => {
                    const again = retry;
                    setRetry(null);
                    setError(null);
                    again();
                  }}
                >
                  重试
                </button>
              ) : undefined
            }
            onClose={() => {
              setError(null);
              setRetry(null);
            }}
          />
        )}

        <div className="field">
          <label>或直接粘贴 JSON 下载地址</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              // Built from the configured repository, so the example is one the
              // user can actually open. A generic shape is shown when the
              // repository has not been read yet.
              placeholder={`${repoBase || "https://你的源仓库"}/yuedu/rsss/json/id/203.json`}
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && importCustom()}
            />
            <button className="primary" onClick={importCustom} disabled={customBusy}>
              {customBusy ? "导入中…" : "导入"}
            </button>
          </div>
        </div>

        <div style={{ maxHeight: "52vh", overflowY: "auto", margin: "0 -4px" }}>
          {cols === null && !error ? (
            <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
              <Spinner />
            </div>
          ) : cols && cols.length === 0 ? (
            <Empty title="这一页没有内容" hint="试试上一页。" />
          ) : (
            <div className="repo-grid" style={{ padding: "4px" }}>
              {cols?.map((c) => (
                <div className="repo-card" key={c.id}>
                  <h4>{c.title || `合集 ${c.id}`}</h4>
                  <div className="repo-meta">
                    <span>{c.author ? `分享者 ${c.author}` : ""}</span>
                    <span>{compactNumber(c.source_count)} 源</span>
                    <span>{compactNumber(c.downloads)} 次下载</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                    <button
                      className="primary"
                      style={{ flex: 1 }}
                      onClick={() => importOne(c)}
                      disabled={importing !== null}
                    >
                      {importing === c.id ? "导入中…" : "导入"}
                    </button>
                    <a
                      href={c.page_url}
                      target="_blank"
                      rel="noreferrer"
                      title="在浏览器中查看这个合集"
                      style={{
                        alignSelf: "center",
                        fontSize: 12,
                        color: "var(--accent)",
                        textDecoration: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      在浏览器中查看 ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            上一页
          </button>
          <span style={{ color: "var(--text-faint)", fontSize: 13 }}>第 {page} 页</span>
          <button onClick={() => setPage((p) => p + 1)}>下一页</button>
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}