import { useEffect, useState } from "react";
import { api, errorMessage, type Collection, type Settings } from "../api";
import { UpdateSettings } from "./Update";
import { Banner, Spinner, compactNumber } from "./ui";

export function SettingsPanel({
  onSourcesChanged,
  onStatsChanged,
}: {
  onSourcesChanged: () => void;
  onStatsChanged: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [dataDir, setDataDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(errorMessage(e)));
    api.listCollections().then(setCollections).catch((e) => setError(errorMessage(e)));
    api.dataDir().then(setDataDir).catch(() => {});
  }, []);

  async function save(next: Settings) {
    setSettings(next);
    try {
      await api.setSettings(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removeAll() {
    const sources = await api.listSources();
    if (sources.length === 0) return;
    if (
      !window.confirm(`确定要删除全部 ${sources.length} 个源吗？此操作不可撤销。`)
    ) {
      return;
    }
    try {
      await api.removeSources(sources.map((s) => s.id));
      onSourcesChanged();
      onStatsChanged();
      setNote("已删除全部源");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!settings) {
    return (
      <div className="main-body">
        <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="main-head">
        <div className="main-title">设置</div>
      </div>
      <div className="main-body">
        <div className="reader">
          {error && <Banner text={error} onClose={() => setError(null)} />}
          {note && <Banner text={note} onClose={() => setNote(null)} />}

          <div className="field">
            <label>源仓库地址</label>
            <input
              value={settings.repo_base}
              onChange={(e) => setSettings({ ...settings, repo_base: e.target.value })}
              onBlur={() => save(settings)}
            />
          </div>

          <div className="field">
            <label>每页条数</label>
            <input
              type="number"
              min={10}
              max={500}
              value={settings.page_size}
              onChange={(e) =>
                setSettings({ ...settings, page_size: Number(e.target.value) || 60 })
              }
              onBlur={() => save(settings)}
            />
          </div>

          <div className="field">
            <label>
              <input
                type="checkbox"
                style={{ width: "auto", marginRight: 8 }}
                checked={settings.concurrent_checks}
                onChange={(e) => save({ ...settings, concurrent_checks: e.target.checked })}
              />
              批量检测时并发请求
            </label>
          </div>

          <div className="field">
            <label title="源声明需要 JavaScript 而页面没解析出内容时，用离屏浏览器渲染一次再解析">
              <input
                type="checkbox"
                style={{ width: "auto", marginRight: 8 }}
                checked={settings.render_js}
                onChange={(e) => save({ ...settings, render_js: e.target.checked })}
              />
              用浏览器渲染脚本页面
            </label>
            <p style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
              少数站点的内容由脚本生成。打开后，只有「这一页解析不出任何条目」时才会多花约 2 秒做一次离屏渲染；
              在 16 个够不着的真实源上实测救回 2 个，因此默认关闭。
            </p>
          </div>

          <h3 style={{ fontSize: 15, margin: "26px 0 10px" }}>已导入的合集</h3>
          {collections.length === 0 ? (
            <p style={{ color: "var(--text-faint)", fontSize: 13 }}>还没有导入任何合集。</p>
          ) : (
            collections.map((c) => (
              <div
                key={c.url}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div>{c.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                    {compactNumber(c.count)} 个源
                    {c.author ? ` · ${c.author}` : ""}
                  </div>
                </div>
                <button
                  className="ghost"
                  onClick={async () => {
                    try {
                      await api.removeCollection(c.url);
                      setCollections(await api.listCollections());
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  从记录移除
                </button>
              </div>
            ))
          )}

          <h3 style={{ fontSize: 15, margin: "26px 0 10px" }}>应用更新</h3>
          <UpdateSettings />

          <h3 style={{ fontSize: 15, margin: "26px 0 10px" }}>数据</h3>
          {dataDir && (
            <p style={{ fontSize: 12, color: "var(--text-faint)", wordBreak: "break-all" }}>
              数据目录：{dataDir}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={removeAll}>删除全部源</button>
            <button
              onClick={async () => {
                const n = await api.clearCache();
                setNote(n > 0 ? `已清理 ${n} 条缓存` : "缓存本来就是空的");
              }}
            >
              清理内容缓存
            </button>
            <button
              onClick={async () => {
                await api.clearCookies();
                setNote("已清除 Cookie 与脚本缓存");
              }}
            >
              清除 Cookie
            </button>
          </div>
        </div>
      </div>
    </>
  );
}