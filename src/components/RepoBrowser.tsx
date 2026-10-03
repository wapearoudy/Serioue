import { useEffect, useState } from "react";
import { api, errorMessage, type RepoCollection } from "../api";
import { Banner, Empty, Spinner, compactNumber } from "./ui";

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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .repoIndex(page)
      .then((c) => {
        if (!cancelled) setCols(c);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  async function importOne(c: RepoCollection) {
    setImporting(c.id);
    setError(null);
    try {
      const res = await api.importFromUrl(c.json_url, c.title);
      setDone(`已导入「${c.title}」：新增 ${res.added} 个源，跳过 ${res.skipped} 个重复源`);
      onImported();
    } catch (err) {
      setError(errorMessage(err));
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
    } finally {
      setCustomBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 860 }} onClick={(e) => e.stopPropagation()}>
        <h3>从源仓库导入合集</h3>

        {done && <Banner text={done} onClose={() => setDone(null)} />}
        {error && <Banner text={error} onClose={() => setError(null)} />}

        <div className="field">
          <label>或直接粘贴 JSON 下载地址</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="https://www.yck2026.fun/yuedu/rsss/json/id/203.json"
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
                    <a href={c.page_url} target="_blank" rel="noreferrer">
                      <button title="在浏览器中查看">↗</button>
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