import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type ArticleItem, type Highlight } from "../api";
import { Gallery, extractImages, extractSubtitles, sanitize } from "./media";
import { isPlayable } from "./VideoPlayer";
import { VideoPlayer } from "./VideoPlayer";
import { MusicPlayer, attachLyrics, extractAudio, isAudioUrl, type Track } from "./MusicPlayer";
import { clearHighlights, paintHighlight } from "./highlight";
import { ReaderSettings } from "./ReaderSettings";
import { Sentences, TtsPanel, firstVisibleSentence, splitSentences, type SentenceRef } from "./TtsPanel";
import { useKeyboardRows } from "./keyboardRow";
import { useDialogFocus } from "./focusTrap";
import { Banner, Spinner } from "./ui";
import type { ArticleResponse, Settings } from "../api";

/** Keeps an episode title readable inside a fixed-width dropdown. */
function truncate(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * The in-app note editor that replaced `window.prompt`.
 *
 * It shows the quoted passage (so the note is written with the sentence in
 * view, not from memory), takes multiple lines, and keeps the draft when
 * saving fails — the same contract `HighlightsPanel` already honours. Focus
 * behaviour comes from the shared `useDialogFocus`: the hook moves focus into
 * the box on open, traps Tab inside, closes on Escape, and hands focus back to
 * the opener (the 笔记 button, which the caller focuses explicitly because the
 * toolbar's mousedown guard would otherwise leave focus on <body>).
 */
function NoteDialog({
  quote,
  draft,
  onDraft,
  saving,
  error,
  onSave,
  onClose,
}: {
  quote: string;
  draft: string;
  onDraft: (v: string) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  return (
    <div
      data-note-dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label="给划线加笔记"
      // Inline rather than in the shared stylesheet: this round is not allowed
      // to touch styles.css, and the editor must stay inside the app's own
      // theme variables so it never flashes a white system box at night.
      style={{
        position: "fixed",
        left: "50%",
        top: "24%",
        transform: "translateX(-50%)",
        zIndex: 60,
        width: "min(440px, 90vw)",
        padding: 14,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 8px 22px rgb(0 0 0 / 45%)",
      }}
    >
      <blockquote
        data-note-quote
        style={{
          margin: "0 0 10px",
          paddingLeft: 11,
          borderLeft: "3px solid var(--accent)",
          color: "var(--text)",
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        {quote}
      </blockquote>
      <textarea
        data-note-input
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSave();
        }}
        placeholder="写点什么…（多行可写，Ctrl+Enter 保存）"
        aria-label="笔记内容"
        rows={3}
        style={{ width: "100%", fontSize: 13, resize: "vertical" }}
      />
      {error && (
        <div data-note-error style={{ color: "var(--err)", fontSize: 12, marginTop: 6 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="primary" data-note-save disabled={saving} onClick={onSave}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button className="ghost" data-note-cancel onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * Wrap every sentence in a rich page so it can be pointed at.
 *
 * The rich view is the source's own HTML, so the sentences cannot be marked up
 * by React — they are found after the fact by walking text nodes. Each text node
 * is split on its own: a sentence that straddles a `<strong>` becomes two
 * fragments, which is inaudible and harmless, whereas trying to merge across
 * elements would mean rebuilding the source's markup.
 *
 * Highlights still work afterwards — `<mark>` is drawn *inside* these spans, and
 * `clearHighlights` only unwraps its own marks. The `data-sentences` flag makes
 * the pass run once per page rather than once per state change, so re-painting
 * highlights cannot produce spans inside spans.
 *
 * Returns the sentences in reading order, for the panel to speak.
 */
function markSentences(root: HTMLElement): SentenceRef[] {
  if (root.dataset.sentences === "1") return sentencesFromDom(root);
  const out: SentenceRef[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-sentence-index]")) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    nodes.push(n as Text);
    n = walker.nextNode();
  }

  for (const node of nodes) {
    const parts = splitSentences(node.nodeValue ?? "");
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const span = document.createElement("span");
      span.dataset.sentenceIndex = String(out.length);
      span.textContent = part;
      frag.appendChild(span);
      out.push({ index: out.length, text: part });
    }
    node.parentNode?.replaceChild(frag, node);
  }
  root.dataset.sentences = "1";
  return out;
}

/** Read the sentences back out of a page already marked up. */
function sentencesFromDom(root: ParentNode): SentenceRef[] {
  const out: SentenceRef[] = [];
  root.querySelectorAll<HTMLElement>("[data-sentence-index]").forEach((el) => {
    const index = Number(el.dataset.sentenceIndex);
    if (!Number.isFinite(index)) return;
    out.push({ index, text: el.textContent ?? "" });
  });
  return out.sort((a, b) => a.index - b.index);
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
  /** The source being read, so a highlight can be reopened from its list. */
  currentSourceId?: string;
  onOpenSibling?: (item: ArticleItem) => void;
  settings: Settings | null;
  onSettingsChange: (patch: Partial<Settings>) => void;
  /**
   * Dismiss the load error.
   *
   * Without it the notice had no close button at all (`Banner` only renders one
   * when `onClose` is given) and stayed on screen until another article was
   * opened.
   */
  onErrorClose?: () => void;
  /** Re-issue the same article request. */
  onRetry?: () => void;
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
  currentSourceId,
  onOpenSibling,
  settings,
  onSettingsChange,
  onErrorClose,
  onRetry,
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
  const keyboard = useKeyboardRows();

  // -- 听书 ------------------------------------------------------------------
  const [ttsOpen, setTtsOpen] = useState(false);
  /** Bumped by a reader-initiated scroll; the panel stops and re-bases. */
  const [ttsToken, setTtsToken] = useState(0);
  /** The sentence on screen, so a fresh ▶ starts where the reader is looking. */
  const [visibleStart, setVisibleStart] = useState(0);
  /**
   * How many follow-the-sentence scrolls are currently driving the page.
   *
   * The panel calls `onFollow` *before* it scrolls, so every programmatic
   * scroll arrives claimed: while this count is non-zero, scroll events are
   * ours and must not stop the voice. A scroll with nothing claimed is the
   * reader taking the page back, and only that stops narration.
   *
   * A fixed time window (the old `followUntil = now + 700`) cannot do this
   * job: a smooth scroll's duration grows with its distance (measured
   * 1882ms for 6000px), so any window either murders long follows or swallows
   * real wheel events that land inside it. Counting claimed scrolls from
   * start to actual end has no distance problem.
   */
  const autoScrolls = useRef(0);
  /** Fires when the last claimed scroll has truly finished. */
  const autoScrollDone = useRef<number | null>(null);
  /** The scroll container, so the end-of-scroll listeners have a target. */
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const setBodyRef = useCallback((el: HTMLDivElement | null) => {
    body.current = el;
    scrollEl.current = el;
  }, []);

  // -- highlights ------------------------------------------------------------
  // A highlight is the quoted passage, not a DOM offset: the page is fetched
  // again every time it opens, so an offset from yesterday would point at the
  // wrong sentence.
  const rich = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Highlight[]>([]);
  const markUrl = article?.final_url || articleUrl || "";
  useEffect(() => {
    if (!markUrl) {
      setMarks([]);
      return;
    }
    let cancelled = false;
    api
      .highlightsFor(markUrl)
      .then((list) => {
        if (!cancelled) setMarks(list);
      })
      .catch(() => {
        // Highlights are an extra; failing to load them must not block reading.
      });
    return () => {
      cancelled = true;
    };
  }, [markUrl]);

  // Repaint whenever the DOM is replaced or the set of highlights changes.
  // Clearing first keeps a re-run from nesting marks inside marks. Declared
  // after `view` below, since that is what replaces the DOM.

  /** The passage the reader just selected, and where to put the buttons. */
  const [pending, setPending] = useState<{ text: string; x: number; y: number } | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  /**
   * The open note editor, if any.
   *
   * `quote` is the passage the note belongs to (so it is written with the
   * sentence in view); `draft` is owned by the editor and survives a failed
   * save, exactly like `HighlightsPanel`'s own editor. A failed save used to
   * clear `pending` and drop the words — now the dialog stays open with the
   * text intact, because a notice plus a lost draft is worse than a notice.
   */
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  /** The 笔记 button that opened the editor, so focus can be handed back. */
  const noteTrigger = useRef<HTMLButtonElement>(null);

  const captureSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    // A click in the margin, or a drag that caught a whole block, should not
    // offer to save an empty or enormous highlight.
    if (!selection || selection.rangeCount === 0 || text.length < 2) {
      setPending(null);
      return;
    }
    const el = rich.current;
    if (el && !el.contains(selection.anchorNode)) {
      setPending(null);
      return;
    }
    const box = selection.getRangeAt(0).getBoundingClientRect();
    setPending({ text, x: box.left + box.width / 2, y: box.top });
  };

  /**
   * Open the note editor for the current selection. The panel (not a system
   * prompt) is what asks for the words: the quoted passage stays on screen,
   * several lines fit, and the focus hook handles Escape + focus for us.
   */
  const openNoteEditor = () => {
    if (!pending) return;
    setNoteOpen(pending.text);
    setNoteDraft("");
    setNoteError(null);
  };

  /** Close the editor; focus goes back to the 笔记 button that opened it. */
  const closeNoteEditor = () => {
    setNoteOpen(null);
    setNoteSaving(false);
    setNoteError(null);
    // The toolbar remounts with the dialog gone; wait a frame so the trigger
    // is focusable again before handing focus back.
    requestAnimationFrame(() => noteTrigger.current?.focus());
  };

  const saveHighlight = async (withNote: boolean, note?: string) => {
    if (!pending || !markUrl) return;
    if (withNote && note === undefined) {
      openNoteEditor();
      return;
    }
    if (withNote) setNoteSaving(true);
    else setNoteSaving(false);
    try {
      const saved = await api.addHighlight({
        id: "",
        url: markUrl,
        source_id: currentSourceId ?? "",
        title: article?.title ?? "",
        source_name: sourceName,
        text: pending.text,
        note: (withNote ? note ?? "" : "").trim(),
        created_at: 0,
      });
      setMarks((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]));
      window.getSelection()?.removeAllRanges();
      setPending(null);
      if (withNote) closeNoteEditor();
    } catch (e) {
      if (withNote) {
        // Keep the draft in the box: clearing the panel here would lose the
        // words the reader just wrote. `HighlightsPanel.saveNote` does the
        // same for its own editor (`HighlightsPanel.tsx:86-91`).
        setNoteSaving(false);
        setNoteError(errorMessage(e));
      } else {
        setPending(null);
        setMarkError(errorMessage(e));
      }
    }
  };

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

  // Mark the sentences up before the highlights are painted, so a highlight ends
  // up *inside* a sentence rather than the other way round.
  const [richSentences, setRichSentences] = useState<SentenceRef[]>([]);
  useEffect(() => {
    const el = rich.current;
    if (!el || !view) return;
    setRichSentences(markSentences(el));
  }, [view?.rich]);

  // Repaint whenever the DOM is replaced or the set of highlights changes.
  // Clearing first keeps a re-run from nesting marks inside marks.
  useEffect(() => {
    const el = rich.current;
    if (!el) return;
    clearHighlights(el);
    marks.forEach((m) => paintHighlight(el, m.text, m.id));
  }, [view?.rich, marks]);

  /**
   * The last ratio read while the reader container was alive.
   *
   * When the reader unmounts React has already detached `body.current`, so
   * `readRatio()` used to answer 0 — and 0 means "the reader is at the very
   * top". The unmount save then wrote that 0 over the real position, which is
   * why an article reopened from the beginning. A dead container has no
   * position to report, so the last live reading is kept here and used instead.
   */
  const lastRatio = useRef(0);
  /**
   * Whether this mount has ever actually been scrolled.
   *
   * Saving on the way out only means something once the reader has been
   * somewhere: a cleanup that runs before that has no position to record, and
   * the 0 it would write is not a position at all.
   */
  const scrolled = useRef(false);

  // How far down the readable area the user is.
  const readRatio = () => {
    const el = body.current;
    // "No container" is not "at the top": report what was last measured.
    if (!el || !el.isConnected) return lastRatio.current;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 1) return 0;
    const value = el.scrollTop / scrollable;
    return Math.max(0, Math.min(1, value));
  };

  // Restore the remembered position once per article.
  //
  // The latch is set when the position has actually been fetched, not when the
  // effect starts: StrictMode runs mount effects twice in development (start,
  // cleanup, start again — on the same instance, so the ref survives), and a
  // latch set on the first start makes the second run — the only one whose
  // result is still wanted — return early. A real unmount gives a fresh ref,
  // which is what lets the next opening restore.
  useEffect(() => {
    const url = articleUrl;
    if (!url || !article || restored.current === url) return;
    let cancelled = false;
    api
      .getProgress(url)
      .then((ratio) => {
        if (cancelled) return;
        restored.current = url;
        if (ratio <= 0.01) return;
        // Wait for the layout to settle, or the scroll lands in the wrong place.
        requestAnimationFrame(() => {
          const el = body.current;
          if (!el || !el.isConnected) return;
          el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
          lastRatio.current = ratio;
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
      // Nothing has moved since this reader mounted, so there is no position to
      // record — and writing 0 here wipes the one the reader is about to
      // restore. StrictMode's simulated unmount lands exactly at that moment,
      // which is why the stored position used to disappear before it was read.
      if (force && !scrolled.current) return;
      savedAt.current = now;
      const ratio = readRatio();
      setProgress(ratio);
      api.saveProgress(articleUrl, ratio).catch(() => {
        /* losing a position is not worth interrupting the reader */
      });
    };

    const onScroll = () => {
      // Remember a live reading now: by the time the unmount save runs the
      // container is gone and its scrollTop with it.
      scrolled.current = true;
      lastRatio.current = readRatio();
      persist(false);
      // Scrolling is the reader taking the page back from the voice — unless
      // the scroll was claimed by our own follow-the-sentence scrolling (see
      // `autoScrolls` above). Claimed scrolls never touch the token no matter
      // how long the smooth animation runs; unclaimed ones always do, no
      // matter how soon after a follow they arrive.
      if (autoScrolls.current === 0) {
        setTtsToken((t) => t + 1);
        setVisibleStart(firstVisibleSentence(body.current));
      }
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

  // What the voice reads: the plain-text view owns its sentences, while the rich
  // view's come from the DOM pass above.
  const ttsSentences: SentenceRef[] = useMemo(() => {
    if (!view) return [];
    if (view.rendered === "text") return splitSentences(view.text).map((text, index) => ({ index, text }));
    return richSentences;
  }, [view, richSentences]);

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
        {view && view.rendered !== "music" && view.rendered !== "video" && (
          <button
            className={ttsOpen ? "on" : ""}
            data-reader-action="tts"
            onClick={() => {
              setVisibleStart(firstVisibleSentence(body.current));
              setTtsOpen((o) => !o);
            }}
            title="逐句朗读正文"
          >
            听书
          </button>
        )}
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
              const jump = () => {
                setTocOpen(false);
                onOpenSibling?.(item);
              };
              return (
                <li
                  key={`${item.link}-${i}`}
                  className={i === position ? "current" : ""}
                  onClick={jump}
                  // The only way to change chapter while reading. Without a tab
                  // stop it was mouse-only, so a keyboard reader could not leave
                  // a chapter they had finished.
                  {...keyboard.propsFor(`toc:${item.link}`, jump, {
                    label: `第 ${i + 1} 章 ${item.title || item.link}${
                      finished
                        ? "，已读"
                        : started
                          ? `，已读 ${Math.round((at ?? 0) * 100)}%`
                          : ""
                    }`,
                  })}
                  aria-current={i === position ? "true" : undefined}
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

      {ttsOpen && ttsSentences.length > 0 && (
        <TtsPanel
          // Remounting on a new article is what guarantees the old article's
          // voice is cancelled before the new one can start.
          key={articleUrl || article?.final_url || "article"}
          sentences={ttsSentences}
          root={body.current ?? undefined}
          positionToken={ttsToken}
          startIndex={Math.min(visibleStart, ttsSentences.length - 1)}
          onFollow={() => {
            // Claim the scroll the panel is about to start, and release the
            // claim when that scroll truly ends — not after a guessed number
            // of milliseconds.
            //
            // `scrollend` is the honest signal (Chromium 114+, hence every
            // WebView2 in the field). Where it never fires — an interrupted
            // animation, a platform without the event — the fallback releases
            // the claim after the scroll has sat still for a few frames, so a
            // stuck claim can delay the next takeover by ~100ms at most, never
            // swallow it.
            autoScrolls.current += 1;
            if (autoScrollDone.current !== null) {
              window.clearTimeout(autoScrollDone.current);
              autoScrollDone.current = null;
            }
            const el = scrollEl.current;
            if (el && "onscrollend" in el) {
              const release = () => {
                el.removeEventListener("scrollend", release);
                autoScrolls.current = Math.max(0, autoScrolls.current - 1);
              };
              el.addEventListener("scrollend", release, { once: true });
              // Belt and braces: if the event never comes, do not hold the
              // claim forever. 3s is not a guess about the animation length —
              // the claim survives any number of renewals while scrolling, and
              // this only fires when nothing has moved for far longer than any
              // frame gap.
              autoScrollDone.current = window.setTimeout(() => {
                el.removeEventListener("scrollend", release);
                autoScrolls.current = Math.max(0, autoScrolls.current - 1);
                autoScrollDone.current = null;
              }, 3000);
            } else {
              // No `scrollend` on this platform: release after the scroll has
              // sat still for a few animation frames.
              const scroller = scrollEl.current as HTMLDivElement | null;
              let last = scroller ? scroller.scrollTop : 0;
              let quiet = 0;
              const tick = () => {
                const now = scrollEl.current?.scrollTop ?? last;
                if (Math.abs(now - last) < 1) {
                  quiet += 1;
                  if (quiet >= 5) {
                    autoScrolls.current = Math.max(0, autoScrolls.current - 1);
                    autoScrollDone.current = null;
                    return;
                  }
                } else {
                  last = now;
                  quiet = 0;
                }
                autoScrollDone.current = window.requestAnimationFrame(tick);
              };
              autoScrollDone.current = window.requestAnimationFrame(tick);
            }
          }}
          onClose={() => setTtsOpen(false)}
        />
      )}

      <div className="main-body reader-scroll" ref={setBodyRef}>
        {error && (
          // This one used to be the worst notice in the app: no `onClose`, so
          // the close button never rendered and a failed article left a red bar
          // the reader could only clear by opening another article. It is now
          // closable, and — because a source that just failed very often works
          // on the second attempt — it can also re-issue the same request.
          <Banner
            text={error}
            action={
              onRetry ? (
                <button
                  className="primary"
                  data-retry="article"
                  aria-label="重新加载这篇文章"
                  disabled={loading}
                  onClick={onRetry}
                >
                  {loading ? "重新加载中…" : "重新加载"}
                </button>
              ) : undefined
            }
            onClose={onErrorClose}
          />
        )}
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
                  <Sentences text={view.text} />
                ) : (
                  <p style={{ color: "var(--text-faint)" }}>这个页面没有可显示的文本内容。</p>
                )}
              </div>
            )}

            {(view.rendered === "rich" || view.rendered === "video") && (
              <div
                className="reader-rich"
                ref={rich}
                onMouseUp={captureSelection}
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

      {markError && <Banner text={markError} onClose={() => setMarkError(null)} />}

      {noteOpen && (
        <NoteDialog
          quote={noteOpen}
          draft={noteDraft}
          onDraft={setNoteDraft}
          saving={noteSaving}
          error={noteError}
          onSave={() => void saveHighlight(true, noteDraft)}
          onClose={closeNoteEditor}
        />
      )}

      {pending && !noteOpen && (
        <div
          className="mark-pop"
          style={{ left: pending.x, top: pending.y }}
          role="toolbar"
          aria-label="划线操作"
          onMouseDown={(e) => e.preventDefault()}
        >
          <button onClick={() => void saveHighlight(false)}>高亮</button>
          <button ref={noteTrigger} data-note-trigger onClick={() => void saveHighlight(true)}>
            笔记
          </button>
          <button
            className="ghost"
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setPending(null);
            }}
          >
            取消
          </button>
        </div>
      )}
    </>
  );
}