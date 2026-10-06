// Development harness for the reader: real ReaderSettings component, real
// typography variables, real themes, and a real scrollable column so reading
// progress can be exercised.
//
// Opened at /reader-preview.html while `pnpm dev` is running. Never bundled
// into a release.
//
// The backend is stubbed with an in-memory store so the page runs in a plain
// browser; in the app the same commands go through Tauri IPC.

import "./dev-tauri-stub";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReaderSettings, THEMES, applyReaderSettings } from "./components/ReaderSettings";
import { TtsPanel, firstVisibleSentence, splitSentences, type SentenceRef } from "./components/TtsPanel";
import type { ArticleItem, Settings } from "./api";
import "./styles.css";

const DEFAULTS: Settings = {
  concurrent_checks: true,
  page_size: 60,
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
  render_js: true,
};

const PARAGRAPHS = [
  "阅读器最难的不是把字显示出来,而是让人愿意一直读下去。行距、字号、版心宽度,任何一项不合适,都会在几页之内把人劝退。",
  "微信读书把这一层做成了默认值可以改、且改完立刻生效。它不追求花哨,只保证你读得下去。",
  "记住读到哪儿同样重要。换一台设备、隔一天回来,不用重新找位置,这件事本身就值很多时间。",
  "下面这段只是用来把页面撑高,好让滚动条有东西可滚。真实文章不会有这么规整的段落密度。",
  "排版参数之间是有关系的:字号变大,行距不变,一屏能看的行数就变少;版心变宽,行太长眼睛容易跳行。",
  "所以这些数值应该成组调整,而不是一个个孤立地试。",
  "再补几段,让内容足够长,长到需要滚动才能看完。",
  "如果进度条能记住位置,那么下次打开就应该直接落在这里,而不是回到开头。",
  "这也是验证脚本要检查的核心:滚到一半,重新挂载组件,看位置有没有被还原。",
  "最后一段。到这里上面的内容应该已经被滚过去了。",
];

function Preview() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [progress, setProgress] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  // 听书. Open by default so the panel is measurable without a click, and the
  // watchdog interval is short so a stalled-utterance test does not have to wait
  // ten seconds. The real component still defaults to ten.
  const [ttsOpen, setTtsOpen] = useState(true);
  const [ttsToken, setTtsToken] = useState(0);
  /** The sentence on screen, so a fresh ▶ starts where the reader is looking. */
  const [visibleStart, setVisibleStart] = useState(0);
  const heartbeatMs = Number(new URLSearchParams(location.search).get("heartbeat")) || undefined;
  // Chapter 1 and 2 are marked read, chapter 3 is part-read: the contents has to
  // show the difference.
  const [readChapters] = useState<Record<string, number>>({
    "https://example.com/book/chapter-1": 1,
    "https://example.com/book/chapter-2": 1,
    "https://example.com/book/chapter-3": 0.4,
  });
  const [chapter, setChapter] = useState(2);
  const [offerNext, setOfferNext] = useState(false);
  const declined = useRef<string | null>(null);

  // Stand-in for the list the entry came from, so the table of contents and
  // chapter navigation have something real to work with.
  const chapters: ArticleItem[] = PARAGRAPHS.slice(0, 6).map((_p, i) => ({
    title: `第 ${i + 1} 章`,
    link: `https://example.com/book/chapter-${i + 1}`,
    image: "",
    date: `2024-0${i + 1}-01`,
    kind: "novel",
  }));
  const current = chapters[chapter];

  const change = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      applyReaderSettings(next);
      return next;
    });
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrollable = el.scrollHeight - el.clientHeight;
    setProgress(scrollable <= 1 ? 0 : el.scrollTop / scrollable);
    // A person moving the page stops the voice, exactly as the app does, and the
    // next ▶ reads from what is now on screen.
    if (!following.current) {
      setTtsToken((t) => t + 1);
      setVisibleStart(firstVisibleSentence(el));
    }
    const next = chapters[chapter + 1];
    if (!next || declined.current === next.link) {
      setOfferNext(false);
      return;
    }
    setOfferNext(scrollable - el.scrollTop < 160);
  };

  // The sentences the preview reads, numbered exactly as they are rendered: one
  // continuous run across the paragraphs, so the panel and the spans cannot
  // drift apart.
  const perParagraph = useMemo(() => PARAGRAPHS.map(splitSentences), []);
  const sentences: SentenceRef[] = useMemo(() => {
    const out: SentenceRef[] = [];
    for (const parts of perParagraph) {
      for (const text of parts) out.push({ index: out.length, text });
    }
    return out;
  }, [perParagraph]);
  /** Where each paragraph starts in that run. */
  const offsets = useMemo(() => {
    const out: number[] = [];
    let at = 0;
    for (const parts of perParagraph) {
      out.push(at);
      at += parts.length;
    }
    return out;
  }, [perParagraph]);
  const following = useRef(false);

  // Restore a remembered position on mount, the way the app does.
  useEffect(() => {
    const el = document.querySelector(".reader-scroll");
    if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.35;
  }, []);

  return (
    <>
      <div className="app" style={{ height: "calc(100vh - 36px)", gridTemplateColumns: "1fr" }}>
        <div className="main" style={{ width: "100%" }}>
          <div className="main-head">
            <div className="main-title">
              阅读器预览
              <span>{settings.reader_font_size}px · {settings.reader_theme}</span>
            </div>
            <span className="spacer" />
            {chapters.length > 1 && (
              <button className={tocOpen ? "on" : ""} onClick={() => setTocOpen((o) => !o)}>
                目录
              </button>
            )}
            <ReaderSettings settings={settings} onChange={change} />
            <button className={ttsOpen ? "on" : ""} data-preview-action="tts" onClick={() => setTtsOpen((o) => !o)}>
              听书
            </button>
          </div>

          {ttsOpen && (
            <TtsPanel
              // Remounting per chapter is the app's guarantee that the previous
              // article's voice is cancelled.
              key={current.link}
              sentences={sentences}
              positionToken={ttsToken}
              startIndex={visibleStart}
              heartbeatMs={heartbeatMs}
              onFollow={() => {
                following.current = true;
                window.setTimeout(() => (following.current = false), 700);
              }}
              onClose={() => setTtsOpen(false)}
            />
          )}

          {tocOpen && chapters.length > 1 && (
            <div className="toc">
              <div className="toc-head">
                目录
                <span className="spacer" />
                <button className="ghost" onClick={() => setTocOpen(false)}>
                  ✕
                </button>
              </div>
              <ol className="toc-list">
                {chapters.map((c, i) => (
                  <li
                    key={c.link}
                    className={i === chapter ? "current" : ""}
                    onClick={() => {
                      setTocOpen(false);
                      setChapter(i);
                    }}
                  >
                    <span className="toc-n">{i + 1}</span>
                    <span className={`toc-t${readChapters[c.link] >= 0.98 ? " read" : ""}`}>
                      {readChapters[c.link] >= 0.98 && (
                        <span className="toc-tick" aria-label="已读">
                          ✓
                        </span>
                      )}
                      {c.title}
                    </span>
                    {readChapters[c.link] !== undefined && readChapters[c.link] < 0.98 && (
                      <span
                        className="toc-partial"
                        title={`已读 ${Math.round(readChapters[c.link] * 100)}%`}
                      />
                    )}
                    <span className="toc-d">{c.date}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {offerNext && chapters[chapter + 1] && (
            <div className="chapter-offer">
              <span className="chapter-offer-text">
                本章已读完 · 下一章:{chapters[chapter + 1].title}
              </span>
              <button
                className="primary"
                onClick={() => setChapter((c) => Math.min(chapters.length - 1, c + 1))}
              >
                继续下一章
              </button>
              <button
                className="ghost"
                onClick={() => {
                  declined.current = chapters[chapter + 1].link;
                  setOfferNext(false);
                }}
              >
                暂不
              </button>
            </div>
          )}
          <div className="main-body reader-scroll" onScroll={onScroll}>
            <article className="reader">
              <h1>{current.title}</h1>
              <div className="reader-meta">
                演示源
                {progress > 0.02 && ` · 已读 ${Math.round(progress * 100)}%`}
              </div>
              <div className={`reader-body${settings.reader_font === "serif" ? " serif" : ""}`}>
                {PARAGRAPHS.map((_p, i) => (
                  <p key={i} data-paragraph={i}>
                    {perParagraph[i].map((text, k) => (
                      <span key={k} data-sentence-index={offsets[i] + k}>
                        {text}
                      </span>
                    ))}
                  </p>
                ))}
              </div>
              <div className="chapter-nav">
                <button disabled={chapter === 0} onClick={() => setChapter((c) => Math.max(0, c - 1))}>
                  ← 上一章
                </button>
                <button
                  disabled={chapter === chapters.length - 1}
                  onClick={() => setChapter((c) => Math.min(chapters.length - 1, c + 1))}
                >
                  下一章 →
                </button>
              </div>
            </article>
          </div>
        </div>
      </div>
      <div style={{ padding: 12, fontSize: 12, color: "var(--text-faint)" }}>
        主题：{THEMES.map((t) => t.key).join(" / ")}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);