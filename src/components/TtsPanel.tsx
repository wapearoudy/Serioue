import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Reading aloud, one sentence at a time.
//
// The Web Speech API is the whole engine — no audio files, no network — and it is
// used one sentence per utterance rather than a whole article in one go. That
// choice is what makes the rest of this file possible: with the text in the
// panel we know exactly which sentence is being spoken, so the highlight can
// follow it and 「上一句/下一句」 can be answered without guessing from
// `charIndex`, which every engine reports differently.
//
// Two facts about the platform shape everything below:
//
//   1. `getVoices()` returns an empty array on first call in Chrome and in
//      WebView2, and fills in later; `voiceschanged` is the only notification.
//   2. Long utterances stop silently after roughly fifteen seconds — `speaking`
//      goes false with no `onend` and no `onerror`. The heartbeat below exists
//      for exactly that failure, and the tests prove it recovers rather than
//      merely claiming it does.

/** How often the engine is checked for having stopped without saying so. */
export const HEARTBEAT_MS = 10_000;

/**
 * Longest a single utterance may be.
 *
 * A run of text with no punctuation is the other way to trip the fifteen-second
 * bug, so it is cut at a comma instead of being handed to the engine whole.
 */
const MAX_SENTENCE_CHARS = 140;

/** One sentence of the article, in reading order. */
export type SentenceRef = {
  index: number;
  /** The text as rendered, including its terminator. */
  text: string;
};

/** The first sentence the reader can actually see, so ▶ starts there. */
export function firstVisibleSentence(scope: HTMLElement | null): number {
  if (!scope) return 0;
  const top = scope.getBoundingClientRect().top;
  let found = 0;
  scope.querySelectorAll<HTMLElement>("[data-sentence-index]").forEach((el) => {
    if (found) return;
    if (el.getBoundingClientRect().bottom > top + 8) found = Number(el.dataset.sentenceIndex) || 0;
  });
  return found;
}

export type TtsStatus = "idle" | "playing" | "paused" | "finished";

/**
 * Split prose into sentences, keeping the terminator with its sentence.
 *
 * Chinese and English are cut on different marks because they end differently:
 * a full stop in English is followed by a space, while 。 is not. Text without
 * a terminator is broken at a comma once it grows past {@link MAX_SENTENCE_CHARS},
 * so no single utterance can be long enough to trigger the stall.
 *
 * Whitespace is kept on the sentence it followed, because these strings are
 * rendered as well as spoken and dropping it would run the words together.
 */
export function splitSentences(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) out.push(buf);
    buf = "";
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buf += ch;

    if ("。！？；…!?;".includes(ch)) {
      // ！！ and …… are one beat to a reader, not two.
      while (i + 1 < chars.length && "。！？；…!?;".includes(chars[i + 1])) buf += chars[++i];
      flush();
      continue;
    }
    if (ch === ".") {
      const next = chars[i + 1];
      if (next === undefined || /\s/.test(next)) flush();
      continue;
    }
    if (buf.length >= MAX_SENTENCE_CHARS) {
      // Long run with no terminator: back up to the last comma and cut there.
      const at = Math.max(buf.lastIndexOf("，"), buf.lastIndexOf(","), buf.lastIndexOf("、"));
      if (at > MAX_SENTENCE_CHARS / 2) {
        out.push(buf.slice(0, at + 1));
        buf = buf.slice(at + 1);
      } else {
        flush();
      }
    }
  }
  flush();
  return out;
}

/**
 * The text of the article, split into sentences.
 *
 * Used wherever the reader controls the markup — the plain-text view and the
 * preview page — so both get the same `data-sentence-index` numbering.
 */
export function Sentences({ text }: { text: string }) {
  const sentences = useMemo(() => splitSentences(text), [text]);
  return (
    <p style={{ whiteSpace: "pre-wrap" }}>
      {sentences.map((s, i) => (
        <span key={i} data-sentence-index={i}>
          {s}
        </span>
      ))}
    </p>
  );
}

/** A beat between sentences, longer at a full stop than at a comma. */
export function pauseAfter(text: string, rate: number): number {
  const base = /[。！？!?…]\s*$/.test(text) ? 420 : /[；;]\s*$/.test(text) ? 280 : 180;
  // A faster voice reaches the next sentence sooner, so it waits less.
  return Math.round(base / Math.max(0.5, rate));
}

/** The engine, or null where the platform has none. */
function engine(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

const SETTINGS_KEY = "serious.tts.v1";

type Stored = { rate?: number; pitch?: number; voiceURI?: string };

function loadSettings(): Stored {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

function saveSettings(next: Stored) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the choice still applies to this session */
  }
}

export type TtsPanelProps = {
  sentences: SentenceRef[];
  /** Where the sentence elements live; the document by default. */
  root?: ParentNode;
  /**
   * Bumped when the reader moves in the article.
   *
   * Scrolling is the reader taking the page back, so narration stops and the
   * cursor re-bases onto whatever is now on screen: the next ▶ reads from there
   * rather than carrying on from a place the reader has left.
   */
  positionToken?: number;
  /** Where a fresh ▶ starts. Defaults to the first sentence on screen. */
  startIndex?: number;
  /** Override for the stall watchdog; the tests shorten it to keep runs quick. */
  heartbeatMs?: number;
  /**
   * Called just before the panel scrolls the page itself.
   *
   * The reader treats scrolling as "I am taking over", so it has to be able to
   * tell its own following-scroll from a person moving the page.
   */
  onFollow?: () => void;
  onClose?: () => void;
};

export function TtsPanel({
  sentences,
  root,
  positionToken = 0,
  startIndex = 0,
  heartbeatMs = HEARTBEAT_MS,
  onFollow,
  onClose,
}: TtsPanelProps) {
  const synth = useMemo(engine, []);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState(() => loadSettings().voiceURI ?? "");
  const [rate, setRate] = useState(() => {
    const stored = loadSettings().rate;
    return typeof stored === "number" && stored >= 0.5 && stored <= 3 ? stored : 1;
  });
  const [pitch, setPitch] = useState(() => {
    const stored = loadSettings().pitch;
    return typeof stored === "number" && stored >= 0.5 && stored <= 2 ? stored : 1;
  });
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [cursor, setCursor] = useState(startIndex);
  const [note, setNote] = useState<string | null>(null);
  const [renewals, setRenewals] = useState(0);

  // Refs mirror the state for the timer callbacks, which must not be re-created
  // every time the reader moves a slider.
  const sentencesRef = useRef(sentences);
  const cursorRef = useRef(startIndex);
  const statusRef = useRef<TtsStatus>("idle");
  const rateRef = useRef(rate);
  const pitchRef = useRef(pitch);
  const voiceURIRef = useRef(voiceURI);
  const voicesRef = useRef(voices);
  /** Guards callbacks from utterances we already cancelled. */
  const generation = useRef(0);
  const timeout = useRef<number | null>(null);

  sentencesRef.current = sentences;
  cursorRef.current = cursor;
  statusRef.current = status;
  rateRef.current = rate;
  pitchRef.current = pitch;
  voiceURIRef.current = voiceURI;
  voicesRef.current = voices;

  const total = sentences.length;
  const available = Boolean(synth) && voices.length > 0;

  const clearTimer = () => {
    if (timeout.current !== null) {
      window.clearTimeout(timeout.current);
      timeout.current = null;
    }
  };

  /** Stop the engine and forget any pending continuation. */
  const halt = useCallback(() => {
    generation.current += 1;
    clearTimer();
    // `cancel()` is what actually stops the voice; the state change is only the
    // UI agreeing with it.
    synth?.cancel();
  }, [synth]);

  const speakAt = useCallback(
    (index: number) => {
      if (!synth || index >= sentencesRef.current.length) {
        statusRef.current = "finished";
        setStatus("finished");
        setNote("已经读到这一篇的末尾了。");
        return;
      }
      const text = sentencesRef.current[index]?.text ?? "";
      const trimmed = text.trim();
      if (!trimmed) {
        speakAt(index + 1);
        return;
      }

      const myGeneration = generation.current;
      cursorRef.current = index;
      setCursor(index);

      const utterance = new SpeechSynthesisUtterance(trimmed);
      utterance.rate = rateRef.current;
      utterance.pitch = pitchRef.current;
      const voice = voicesRef.current.find((v) => v.voiceURI === voiceURIRef.current);
      if (voice) utterance.voice = voice;

      utterance.onend = () => {
        // A cancelled utterance still fires `onend`; only the live one counts.
        if (myGeneration !== generation.current || statusRef.current !== "playing") return;
        const wait = pauseAfter(trimmed, rateRef.current);
        timeout.current = window.setTimeout(() => {
          if (myGeneration !== generation.current) return;
          speakAt(index + 1);
        }, wait);
      };
      utterance.onerror = (event) => {
        if (myGeneration !== generation.current) return;
        // Our own cancel() arrives as an error too; it is not a failure.
        if (event.error === "interrupted" || event.error === "canceled") return;
        halt();
        statusRef.current = "idle";
        setStatus("idle");
        setNote(`语音合成中断（${event.error || "未知原因"}），点播放可以重新开始。`);
      };

      synth.speak(utterance);
    },
    [synth, halt],
  );

  const play = useCallback(
    (from?: number) => {
      if (!synth) return;
      if (voices.length === 0) return;
      halt();
      setNote(null);
      statusRef.current = "playing";
      setStatus("playing");
      speakAt(from ?? cursorRef.current);
    },
    [synth, voices.length, halt, speakAt],
  );

  /**
   * Pause by stopping and holding the position, not by `speechSynthesis.pause()`.
   *
   * Pausing the engine and then resuming an utterance this component owns is
   * where Chrome loses the queue; cancelling and remembering the cursor is
   * deterministic and reads identically to the reader.
   */
  const pause = useCallback(() => {
    halt();
    statusRef.current = "paused";
    setStatus("paused");
  }, [halt]);

  const stop = useCallback(() => {
    halt();
    statusRef.current = "idle";
    setStatus("idle");
    setCursor(startIndex);
    cursorRef.current = startIndex;
    setNote(null);
  }, [halt, startIndex]);

  const step = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(total - 1, cursorRef.current + delta));
      if (statusRef.current === "playing") {
        play(next);
      } else {
        cursorRef.current = next;
        setCursor(next);
      }
    },
    [play, total],
  );

  // -- voices ---------------------------------------------------------------
  // The empty first response is normal, so the list is refreshed whenever the
  // engine says it changed rather than only at mount.
  useEffect(() => {
    if (!synth) return;
    const load = () => {
      const list = synth.getVoices();
      if (list.length) setVoices(list);
    };
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, [synth]);

  // -- highlight ------------------------------------------------------------
  // The class is the contract with the stylesheet: the panel never styles the
  // sentence itself, and `.sentence-active` is the only thing it touches.
  useEffect(() => {
    const scope = root ?? document;
    scope.querySelectorAll(".sentence-active").forEach((el) => el.classList.remove("sentence-active"));
    if (statusRef.current !== "playing" && statusRef.current !== "paused") return;
    const el = scope.querySelector(`[data-sentence-index="${cursor}"]`);
    if (!el) return;
    el.classList.add("sentence-active");
    // Follow the voice, but only when the sentence has actually left the screen.
    const box = el.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) {
      onFollow?.();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [cursor, status, root, onFollow]);

  // -- stall watchdog -------------------------------------------------------
  useEffect(() => {
    if (!synth || status !== "playing") return;
    const tick = () => {
      if (statusRef.current !== "playing") return;
      // Speaking or still queued is the healthy case; anything else with text
      // left is the fifteen-second stall, and it is resumed rather than reported.
      if (synth.speaking || synth.pending) return;
      const next = cursorRef.current + 1;
      if (next >= sentencesRef.current.length) {
        statusRef.current = "finished";
        setStatus("finished");
        setNote("已经读到这一篇的末尾了。");
        return;
      }
      setRenewals((n) => n + 1);
      speakAt(next);
    };
    const id = window.setInterval(tick, heartbeatMs);
    return () => window.clearInterval(id);
  }, [synth, status, heartbeatMs, speakAt]);

  // -- lifecycle ------------------------------------------------------------
  // Unmounting must not leave a voice behind: the window outlives this panel and
  // the article behind that.
  useEffect(
    () => () => {
      generation.current += 1;
      clearTimer();
      synth?.cancel();
    },
    [synth],
  );

  // A different article is a different set of sentences; nothing carries over.
  useEffect(() => {
    halt();
    statusRef.current = "idle";
    setStatus("idle");
    setCursor(startIndex);
    cursorRef.current = startIndex;
  }, [sentences, startIndex, halt]);

  // The reader moved: stop, and start again from where the page now is.
  useEffect(() => {
    if (positionToken === 0) return;
    halt();
    statusRef.current = "idle";
    setStatus("idle");
    setCursor(startIndex);
    cursorRef.current = startIndex;
    setNote("阅读位置变了，已停下；再点播放从当前屏幕继续。");
  }, [positionToken, startIndex, halt]);

  const remember = (patch: Stored) => saveSettings({ rate, pitch, voiceURI, ...patch });

  const spoken = cursor + 1;

  return (
    <div
      className="tts-panel"
      // Honest state for a test and for a screen reader: this machine may have
      // no TTS engine at all, and the panel must not pretend otherwise.
      data-tts-available={available ? "1" : "0"}
      data-tts-voices={voices.length}
      data-tts-status={status}
      data-tts-cursor={cursor}
      data-tts-start={startIndex}
      data-tts-total={total}
      data-tts-renewals={renewals}
      data-tts-heartbeat={heartbeatMs}
      data-tts-speaking={synth?.speaking ? "1" : "0"}
      role="group"
      aria-label="听书控制"
    >
      <div className="tts-row">
        <button
          className="primary"
          data-tts-action="play"
          aria-label={status === "playing" ? "暂停朗读" : "开始朗读"}
          disabled={!available || status === "finished"}
          onClick={() => (status === "playing" ? pause() : play())}
        >
          {status === "playing" ? "⏸ 暂停" : "▶ 朗读"}
        </button>
        <button
          data-tts-action="prev"
          aria-label="上一句"
          disabled={!available || cursor <= 0}
          onClick={() => step(-1)}
        >
          ‹ 上一句
        </button>
        <button
          data-tts-action="next"
          aria-label="下一句"
          disabled={!available || cursor >= total - 1}
          onClick={() => step(1)}
        >
          下一句 ›
        </button>
        <button data-tts-action="stop" aria-label="停止朗读" disabled={!available} onClick={stop}>
          ⏹ 停止
        </button>
        <span className="spacer" />
        <span className="tts-progress" aria-label="朗读进度">
          第 {Math.min(spoken, total)} / {total} 句
        </span>
        {onClose && (
          <button className="ghost" data-tts-action="close" aria-label="关闭听书面板" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="tts-row">
        <label className="tts-field">
          语速 {rate.toFixed(1)}×
          <input
            type="range"
            data-tts-action="rate"
            aria-label="语速"
            min={0.5}
            max={3}
            step={0.1}
            value={rate}
            disabled={!available}
            onChange={(e) => {
              const next = Number(e.target.value);
              setRate(next);
              remember({ rate: next });
            }}
          />
        </label>
        <label className="tts-field">
          音高 {pitch.toFixed(1)}
          <input
            type="range"
            data-tts-action="pitch"
            aria-label="音高"
            min={0.5}
            max={2}
            step={0.1}
            value={pitch}
            disabled={!available}
            onChange={(e) => {
              const next = Number(e.target.value);
              setPitch(next);
              remember({ pitch: next });
            }}
          />
        </label>
        <label className="tts-field">
          音色
          <select
            data-tts-action="voice"
            aria-label="选择音色"
            value={voiceURI}
            disabled={!available}
            onChange={(e) => {
              setVoiceURI(e.target.value);
              remember({ voiceURI: e.target.value });
            }}
          >
            <option value="">系统默认</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}（{v.lang}）
              </option>
            ))}
          </select>
        </label>
      </div>

      {!available && (
        <div className="tts-note" data-tts-note="unavailable">
          {synth
            ? "这台设备上没有可用的语音引擎，听书用不了；阅读本身不受影响。"
            : "这个环境不支持语音合成，听书用不了；阅读本身不受影响。"}
        </div>
      )}
      {note && available && (
        // Dismissible, not merely informative: a synthesis failure is an error
        // the reader may want to clear without starting a new session. The
        // 「没有语音引擎」 notice above is not dismissible — it describes the
        // machine, not this run.
        <div className="tts-note" data-tts-note="1">
          <span>{note}</span>
          <button
            className="ghost"
            data-tts-action="dismiss-note"
            aria-label="关闭提示"
            onClick={() => setNote(null)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="tts-live" aria-live="polite">
        {status === "playing" ? sentences[cursor]?.text.trim() ?? "" : ""}
      </div>
    </div>
  );
}
