import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Gallery, extractImages, sanitize } from "./media";
import { isPlayable } from "./VideoPlayer";
import { VideoPlayer } from "./VideoPlayer";
import { MusicPlayer, extractAudio, isAudioUrl, type Track } from "./MusicPlayer";
import { ReaderSettings } from "./ReaderSettings";
import { Banner, Spinner } from "./ui";
import type { ArticleResponse, Settings } from "../api";

type Props = {
  loading: boolean;
  error: string | null;
  article: ArticleResponse | null;
  sourceName: string;
  /** The list entry that was opened, used to title tracks and pick a start. */
  itemKind?: string;
  /** The URL to remember a reading position against. */
  articleUrl?: string;
  settings: Settings | null;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onBack: () => void;
  onOpenExternal: (url: string) => void;
};

export function Reader({
  loading,
  error,
  article,
  sourceName,
  itemKind,
  articleUrl,
  settings,
  onSettingsChange,
  onBack,
  onOpenExternal,
}: Props) {
  const [mode, setMode] = useState<"auto" | "text" | "rich">("auto");
  const body = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const restored = useRef<string | null>(null);
  const savedAt = useRef(0);

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

  // How far down the readable area the user is.
  const readRatio = () => {
    const el = body.current;
    if (!el) return 0;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 1) return 0;
    const value = el.scrollTop / scrollable;
    return Math.max(0, Math.min(1, value));
  };

  // Restore the remembered position once per article.
  useEffect(() => {
    const url = articleUrl;
    if (!url || !article || restored.current === url) return;
    restored.current = url;
    let cancelled = false;
    api
      .getProgress(url)
      .then((ratio) => {
        if (cancelled || ratio <= 0.01) return;
        // Wait for the layout to settle, or the scroll lands in the wrong place.
        requestAnimationFrame(() => {
          const el = body.current;
          if (!el) return;
          el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
          setProgress(ratio);
        });
      })
      .catch(() => {
        /* no stored position for this article */
      });
    return () => {
      cancelled = true;
    };
  }, [article, articleUrl]);

  // Save while scrolling, throttled, and once more when leaving.
  useEffect(() => {
    const el = body.current;
    if (!el || !articleUrl || !article) return;

    const persist = (force: boolean) => {
      const now = Date.now();
      if (!force && now - savedAt.current < 1200) return;
      savedAt.current = now;
      const ratio = readRatio();
      setProgress(ratio);
      api.saveProgress(articleUrl, ratio).catch(() => {
        /* losing a position is not worth interrupting the reader */
      });
    };

    const onScroll = () => persist(false);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      persist(true);
    };
  }, [article, articleUrl]);

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
        <ReaderSettings settings={settings} onChange={onSettingsChange} />
        {article && (
          <button onClick={() => onOpenExternal(article.final_url)} title="在浏览器中打开">
            ↗
          </button>
        )}
      </div>

      <div className="main-body reader-scroll" ref={body}>
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
              {progress > 0.02 && ` · 已读 ${Math.round(progress * 100)}%`}
            </div>

            <div className={`reader-body${settings?.reader_font === "serif" ? " serif" : ""}`}>

            {view.rendered === "music" && (
              <MusicPlayer tracks={view.tracks} title={sourceName} />
            )}

            {view.rendered === "video" && view.video && (
              <VideoPlayer
                src={view.video}
                poster={view.images[0]}
                title={article!.title}
                resumeKey={articleUrl}
              />
            )}

            {view.rendered === "gallery" && <Gallery images={view.images} />}

            {view.rendered === "text" && (
              <div>
                {view.text ? (
                  <p style={{ whiteSpace: "pre-wrap" }}>{view.text}</p>
                ) : (
                  <p style={{ color: "var(--text-faint)" }}>这个页面没有可显示的文本内容。</p>
                )}
              </div>
            )}

            {(view.rendered === "rich" || view.rendered === "video") && (
              <div
                className="reader-rich"
                dangerouslySetInnerHTML={{ __html: view.rich }}
              />
            )}

            {view.text.length < 40 && view.rendered !== "text" && (
              <div style={{ marginTop: 26, paddingTop: 18, borderTop: "1px solid var(--border)" }}>
                <button onClick={() => setMode("text")}>查看纯文本</button>
              </div>
            )}
            </div>
          </article>
        )}
      </div>
    </>
  );
}