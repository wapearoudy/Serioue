import { useMemo, useState } from "react";
import { Gallery, VideoPlayer, extractImages, isPlayable, sanitize } from "./media";
import { MusicPlayer, extractAudio, isAudioUrl, type Track } from "./MusicPlayer";
import { Banner, Spinner } from "./ui";
import type { ArticleResponse } from "../api";

type Props = {
  loading: boolean;
  error: string | null;
  article: ArticleResponse | null;
  sourceName: string;
  /** The list entry that was opened, used to title tracks and pick a start. */
  itemKind?: string;
  onBack: () => void;
  onOpenExternal: (url: string) => void;
};

export function Reader({
  loading,
  error,
  article,
  sourceName,
  itemKind,
  onBack,
  onOpenExternal,
}: Props) {
  const [mode, setMode] = useState<"auto" | "text" | "rich">("auto");

  const view = useMemo(() => {
    if (!article) return null;
    const rich = sanitize(article.html);

    // Prefer a playable stream when the source exposes one. Audio is checked
    // first: a page that carries both a player and a poster image should open
    // as music, not as a gallery.
    const audio = article.audio ?? extractAudio(article.html, article.final_url);
    const video = article.media.find((m) => isPlayable(m) && !isAudioUrl(m)) ?? null;
    const images = extractImages(article.html, article.final_url);
    const text = article.text.trim();

    const hasRich = /<(video|img|p|h[1-6]|table|ul|ol|pre)\b/i.test(rich);
    let rendered: "video" | "gallery" | "music" | "rich" | "text" = "text";
    if (mode === "text") rendered = "text";
    else if (mode === "rich") rendered = hasRich ? "rich" : "text";
    else if (audio.length > 0) rendered = "music";
    else if (video) rendered = "video";
    else if (images.length >= 3 && !text) rendered = "gallery";
    else if (hasRich) rendered = "rich";
    else rendered = "text";

    // The opening item, when it is itself a track, leads the queue.
    const tracks: Track[] = audio.map((url) => ({ url, title: "" }));
    if (itemKind === "music" && tracks.length > 1) {
      // A track page listing the whole album: name every track from its anchor
      // text so the queue is not a column of identical filenames.
      const doc = new DOMParser().parseFromString(article.html, "text/html");
      const byUrl = new Map<string, string>();
      doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") ?? "";
        try {
          byUrl.set(new URL(href, article.final_url).toString(), (a.textContent ?? "").trim());
        } catch {
          /* keep the raw href out of the map */
        }
      });
      for (const t of tracks) {
        const label = byUrl.get(t.url) ?? "";
        if (label) t.title = label;
      }
    }

    return { rich, video, images, text, rendered, tracks };
  }, [article, mode, itemKind]);

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
              {view.tracks.length > 0 && ` · ${view.tracks.length} 首`}
              {article!.media.length > 0 && view.tracks.length === 0 && ` · ${article!.media.length} 个媒体资源`}
            </div>

            {view.rendered === "music" && (
              <MusicPlayer tracks={view.tracks} title={sourceName} />
            )}

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