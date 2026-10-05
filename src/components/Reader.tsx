import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ArticleItem } from "../api";
import { Gallery, extractImages, extractSubtitles, sanitize } from "./media";
import { isPlayable } from "./VideoPlayer";
import { VideoPlayer } from "./VideoPlayer";
import { MusicPlayer, attachLyrics, extractAudio, isAudioUrl, type Track } from "./MusicPlayer";
import { ReaderSettings } from "./ReaderSettings";
import { Banner, Spinner } from "./ui";
import type { ArticleResponse, Settings } from "../api";

/** Keeps an episode title readable inside a fixed-width dropdown. */
function truncate(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

type Props = {
  loading: boolean;
  error: string | null;
  article: ArticleResponse | null;
  sourceName: string;
  /** The list entry that was opened, used to title tracks and pick a start. */
  itemKind?: string;
  /** The URL to remember a reading position against. */
  articleUrl?: string;
  /** The list the entry came from, used as a table of contents. */
  siblings?: ArticleItem[];
  /** The link of the entry being read, so the contents can highlight it. */
  currentLink?: string;
  onOpenSibling?: (item: ArticleItem) => void;
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
  siblings = [],
  currentLink,
  onOpenSibling,
  settings,
  onSettingsChange,
  onBack,
  onOpenExternal,
}: Props) {
  const [mode, setMode] = useState<"auto" | "text" | "rich">("auto");
  const [tocOpen, setTocOpen] = useState(false);
  /** Which chapters have been read, so the contents can mark them. */
  const [readChapters, setReadChapters] = useState<Record<string, number>>({});
  const body = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const restored = useRef<string | null>(null);
  const savedAt = useRef(0);

  // Chapter navigation is only meaningful when the entry came from a list.
  const position = useMemo(() => {
    if (siblings.length < 2 || !currentLink) return -1;
    return siblings.findIndex((i) => i.link === currentLink);
  }, [siblings, currentLink]);
  const prevChapter = position > 0 ? siblings[position - 1] : null;
  const nextChapter = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null;

  // Fetch the whole list's reading positions when the contents opens, so a
  // reader can see at a glance what is left.
  useEffect(() => {
    if (!tocOpen || siblings.length < 2) return;
    let cancelled = false;
    api
      .getProgressMany(siblings.map((s) => s.link))
      .then((map) => {
        if (!cancelled) setReadChapters(map);
      })
      .catch(() => {
        /* marks are a nicety; failing to load them is not an error */
      });
    return () => {
      cancelled = true;
    };
  }, [tocOpen, siblings]);

  // Offer the next chapter once the reader reaches the end, the way a book
  // does. Dismissal is remembered per chapter so it does not reappear on every
  // scroll back up.
  const [offerNext, setOfferNext] = useState(false);
  const declinedNext = useRef<string | null>(null);
  useEffect(() => {
    setOfferNext(false);
    declinedNext.current = null;
  }, [currentLink]);

  const view = useMemo(() => {
    if (!article) return null;
    const rich = sanitize(article.html);

    // Prefer a playable stream when the source exposes one. Audio is checked
    // first: a page that carries both a player and a poster image should open
    // as music, not as a gallery.
    const audio = article.audio ?? extractAudio(article.html, article.final_url);
    const video = article.media.find((m) => isPlayable(m) && !isAudioUrl(m)) ?? null;
    const images = extractImages(article.html, article.final_url);
    const subtitles = extractSubtitles(article.html, article.final_url);
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

    // Lyric files are linked next to the audio; attach the matching one to each
    // track so the player can follow along.
    const withLyrics = attachLyrics(tracks, article.html, article.final_url);

    return { rich, video, images, text, rendered, tracks: withLyrics, subtitles };
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

    const onScroll = () => {
      persist(false);
      // Near the end of a chapter, offer the next one.
      const el = body.current;
      if (!el || !nextChapter || declinedNext.current === nextChapter.link) {
        setOfferNext(false);
        return;
      }
      const atEnd = el.scrollHeight - el.clientHeight - el.scrollTop < 160;
      setOfferNext(atEnd);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      persist(true);
    };
  }, [article, articleUrl, nextChapter]);

  // `]` / `[` move between chapters; `t` toggles the contents.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!onOpenSibling) return;
      const el = document.activeElement;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      const target = e.key === "]" ? nextChapter : e.key === "[" ? prevChapter : null;
      if (target) {
        e.preventDefault();
        onOpenSibling(target);
      } else if (e.key === "t" || e.key === "T") {
        if (siblings.length > 1) {
          e.preventDefault();
          setTocOpen((o) => !o);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextChapter, prevChapter, siblings.length, onOpenSibling]);

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
        {siblings.length > 1 && (
          <button
            className={tocOpen ? "on" : ""}
            onClick={() => setTocOpen((o) => !o)}
            title="目录 (T)"
          >
            目录
          </button>
        )}
        {article && (
          <button onClick={() => onOpenExternal(article.final_url)} title="在浏览器中打开">
            ↗
          </button>
        )}
      </div>

      {tocOpen && siblings.length > 1 && (
        <div className="toc">
          <div className="toc-head">
            目录
            <span className="spacer" />
            <button className="ghost" onClick={() => setTocOpen(false)} aria-label="关闭目录">
              ✕
            </button>
          </div>
          <ol className="toc-list">
            {siblings.map((item, i) => {
              const at = readChapters[item.link];
              const finished = at !== undefined && at >= 0.98;
              const started = at !== undefined && !finished;
              return (
                <li
                  key={`${item.link}-${i}`}
                  className={i === position ? "current" : ""}
                  onClick={() => {
                    setTocOpen(false);
                    onOpenSibling?.(item);
                  }}
                >
                  <span className="toc-n">{i + 1}</span>
                  <span className={`toc-t${finished ? " read" : ""}`}>
                    {finished && <span className="toc-tick" aria-label="已读">✓</span>}
                    {item.title || item.link}
                  </span>
                  {started && !finished && (
                    <span className="toc-partial" title={`已读 ${Math.round(at * 100)}%`} />
                  )}
                  {item.date && <span className="toc-d">{item.date}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {offerNext && nextChapter && (
        <div className="chapter-offer">
          <span className="chapter-offer-text">本章已读完 · 下一章:{nextChapter.title || "继续"}</span>
          <button
            className="primary"
            onClick={() => {
              setOfferNext(false);
              onOpenSibling?.(nextChapter);
            }}
          >
            继续下一章
          </button>
          <button
            className="ghost"
            onClick={() => {
              declinedNext.current = nextChapter.link;
              setOfferNext(false);
            }}
          >
            暂不
          </button>
        </div>
      )}

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
              <MusicPlayer
                tracks={view.tracks}
                title={sourceName}
                volume={settings?.player_volume}
                onVolumeChange={(v) => onSettingsChange({ player_volume: v })}
              />
            )}

            {view.rendered === "video" && view.video && (
              <VideoPlayer
                src={view.video}
                poster={view.images[0]}
                title={article!.title}
                resumeKey={articleUrl}
                subtitles={view.subtitles}
                nextTitle={nextChapter?.title}
                onNext={nextChapter && onOpenSibling ? () => onOpenSibling(nextChapter) : undefined}
                volume={settings?.player_volume}
                rate={settings?.player_rate}
                onVolumeChange={(v) => onSettingsChange({ player_volume: v })}
                onRateChange={(r) => onSettingsChange({ player_rate: r })}
              />
            )}

            {view.rendered === "video" && view.video && siblings.length > 1 && onOpenSibling && (
              <div className="episodes">
                <button
                  disabled={!prevChapter}
                  onClick={() => prevChapter && onOpenSibling(prevChapter)}
                  title={prevChapter ? prevChapter.title || "上一集" : "已是第一集"}
                  aria-label="上一集"
                >
                  ‹
                </button>
                <span className="episodes-label">选集</span>
                <select
                  className="episodes-select"
                  value={position >= 0 ? position : -1}
                  onChange={(e) => {
                    const item = siblings[Number(e.target.value)];
                    if (item) onOpenSibling(item);
                  }}
                  aria-label="选择剧集"
                >
                  {position < 0 && <option value={-1}>选择剧集</option>}
                  {siblings.map((item, i) => (
                    <option key={`${item.link}-${i}`} value={i}>
                      {/* Many sources already number their episodes in the
                          title, so the position is shown by the counter beside
                          the picker rather than repeated in every entry. */}
                      {truncate(item.title || item.link, 40)}
                    </option>
                  ))}
                </select>
                <button
                  disabled={!nextChapter}
                  onClick={() => nextChapter && onOpenSibling(nextChapter)}
                  title={nextChapter ? nextChapter.title || "下一集" : "已是最后一集"}
                  aria-label="下一集"
                >
                  ›
                </button>
                {position >= 0 && (
                  <span className="episodes-count">
                    第 {position + 1} / {siblings.length} 集
                  </span>
                )}
              </div>
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

            {(prevChapter || nextChapter) && (
              <div className="chapter-nav">
                <button disabled={!prevChapter} onClick={() => prevChapter && onOpenSibling?.(prevChapter)}>
                  ← 上一章
                </button>
                <button disabled={!nextChapter} onClick={() => nextChapter && onOpenSibling?.(nextChapter)}>
                  下一章 →
                </button>
              </div>
            )}
            </div>
          </article>
        )}
      </div>
    </>
  );
}