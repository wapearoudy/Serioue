import { useMemo, useState } from "react";
import { Gallery, VideoPlayer, extractImages, isPlayable, sanitize } from "./media";
import { Banner, Spinner } from "./ui";
import type { ArticleResponse } from "../api";

type Props = {
  loading: boolean;
  error: string | null;
  article: ArticleResponse | null;
  sourceName: string;
  onBack: () => void;
  onOpenExternal: (url: string) => void;
};

export function Reader({ loading, error, article, sourceName, onBack, onOpenExternal }: Props) {
  const [mode, setMode] = useState<"auto" | "text" | "rich">("auto");

  const view = useMemo(() => {
    if (!article) return null;
    const rich = sanitize(article.html);

    // Prefer a playable stream when the source exposes one.
    const video = article.media.find(isPlayable) ?? null;
    const images = extractImages(article.html, article.final_url);
    const text = article.text.trim();

    const hasRich = /<(video|img|p|h[1-6]|table|ul|ol|pre)\b/i.test(rich);
    let rendered: "video" | "gallery" | "rich" | "text" = "text";
    if (mode === "text") rendered = "text";
    else if (mode === "rich") rendered = hasRich ? "rich" : "text";
    else if (video) rendered = "video";
    else if (images.length >= 3 && !text) rendered = "gallery";
    else if (hasRich) rendered = "rich";
    else rendered = "text";

    return { rich, video, images, text, rendered };
  }, [article, mode]);

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onBack}>
          ← 返回
        </button>
        <div className="main-title">{article?.title || sourceName}</div>
        <span className="spacer" />
        {view && (
          <div style={{ display: "flex", gap: 2 }}>
            <button
              className={`tab${mode === "auto" ? " active" : ""}`}
              onClick={() => setMode("auto")}
            >
              自动
            </button>
            <button
              className={`tab${mode === "rich" ? " active" : ""}`}
              onClick={() => setMode("rich")}
            >
              原页
            </button>
            <button
              className={`tab${mode === "text" ? " active" : ""}`}
              onClick={() => setMode("text")}
            >
              纯文本
            </button>
          </div>
        )}
        {article && (
          <button onClick={() => onOpenExternal(article.final_url)} title="在浏览器中打开">
            ↗
          </button>
        )}
      </div>

      <div className="main-body">
        {error && <Banner text={error} />}
        {loading && (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        )}

        {view && (
          <article className="reader">
            <h1>{article!.title || "无标题"}</h1>
            <div className="reader-meta">
              {sourceName}
              {article!.media.length > 0 && ` · ${article!.media.length} 个媒体资源`}
            </div>

            {view.rendered === "video" && view.video && (
              <VideoPlayer src={view.video} poster={view.images[0]} />
            )}

            {view.rendered === "gallery" && <Gallery images={view.images} />}

            {view.rendered === "text" && (
              <div className="reader-body">
                {view.text ? (
                  <p style={{ whiteSpace: "pre-wrap" }}>{view.text}</p>
                ) : (
                  <p style={{ color: "var(--text-faint)" }}>这个页面没有可显示的文本内容。</p>
                )}
              </div>
            )}

            {(view.rendered === "rich" || view.rendered === "video") && (
              <div
                className="reader-body"
                dangerouslySetInnerHTML={{ __html: view.rich }}
              />
            )}

            {view.text.length < 40 && view.rendered !== "text" && (
              <div style={{ marginTop: 26, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
                <button onClick={() => setMode("text")}>查看纯文本</button>
              </div>
            )}
          </article>
        )}
      </div>
    </>
  );
}