import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Highlight } from "../api";
import { Banner, Empty, Spinner, timeAgo } from "./ui";
import { preview } from "./highlight";
import { useKeyboardRows } from "./keyboardRow";

export function HighlightsPanel({
  onOpen,
  onClose,
}: {
  /** Open the article a highlight belongs to. */
  onOpen: (h: Highlight) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Highlight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useKeyboardRows();

  // -- finding a highlight among hundreds ------------------------------------
  /** Both the passage and the note, because the note is half of what is here. */
  const [query, setQuery] = useState("");
  const [onlyNotes, setOnlyNotes] = useState(false);

  // -- editing a note --------------------------------------------------------
  /** The highlight whose note is open in the editor, or null. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // -- deleting --------------------------------------------------------------
  /** The highlight waiting to be confirmed, or null. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** The last deleted highlight, offered back for a few seconds. */
  const [deleted, setDeleted] = useState<Highlight | null>(null);
  const undoTimer = useRef(0);

  const load = () => {
    setItems(null);
    setError(null);
    api
      .listHighlights()
      .then(setItems)
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(load, []);

  // The undo offer is a promise with a deadline; leaving one behind would keep a
  // deleted highlight alive in the interface forever.
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  /** Replace one highlight in place, without refetching the whole list. */
  const patchLocal = (id: string, patch: Partial<Highlight>) =>
    setItems((prev) => (prev ? prev.map((h) => (h.id === id ? { ...h, ...patch } : h)) : prev));

  const startEdit = (h: Highlight) => {
    setEditingId(h.id);
    setDraft(h.note ?? "");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
    setEditError(null);
  };

  /**
   * Save the note.
   *
   * Empty means "no note", and is sent as `null` so the meaning survives the
   * trip. The list is patched locally rather than re-added: `addHighlight`
   * de-duplicates by passage and would hand back the record *with the old
   * note*, silently undoing what was just typed.
   */
  const saveNote = async (h: Highlight) => {
    const text = draft.trim();
    setSaving(true);
    setEditError(null);
    try {
      await api.updateHighlightNote(h.id, text === "" ? null : text);
      patchLocal(h.id, { note: text });
      cancelEdit();
    } catch (e) {
      // The editor stays open with the text intact: a failed save that clears
      // the box is a failed save that also loses the words.
      setEditError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  /** Remove the note but keep the highlight. */
  const clearNote = async (h: Highlight) => {
    setEditError(null);
    try {
      await api.updateHighlightNote(h.id, null);
      patchLocal(h.id, { note: "" });
      if (editingId === h.id) cancelEdit();
    } catch (e) {
      setEditError(errorMessage(e));
    }
  };

  const remove = async (h: Highlight) => {
    try {
      await api.removeHighlight(h.id);
      setItems((prev) => (prev ? prev.filter((x) => x.id !== h.id) : prev));
      setConfirmId(null);
      if (editingId === h.id) cancelEdit();
      // A confirmation is a pause, not a promise that it can never be wrong.
      setDeleted(h);
      window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setDeleted(null), 8000);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Put a deleted highlight back. Re-adding is right here: the record is gone. */
  const undoRemove = async () => {
    const h = deleted;
    if (!h) return;
    window.clearTimeout(undoTimer.current);
    setDeleted(null);
    try {
      await api.addHighlight(h);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const all = items ?? [];
  const q = query.trim().toLowerCase();
  const filtered = all.filter((h) => {
    if (onlyNotes && !h.note) return false;
    if (!q) return true;
    return (
      (h.text ?? "").toLowerCase().includes(q) ||
      (h.note ?? "").toLowerCase().includes(q) ||
      (h.title ?? "").toLowerCase().includes(q) ||
      (h.source_name ?? "").toLowerCase().includes(q)
    );
  });
  const noted = all.filter((h) => h.note).length;
  const filtering = q !== "" || onlyNotes;

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">划线与笔记</div>
        <span className="spacer" />
        {items && items.length > 0 && (
          <span className="marks-count" data-marks-count="1">
            {filtering ? `${filtered.length} / ${all.length} 条` : `${all.length} 条`}
            {noted > 0 && ` · ${noted} 条有笔记`}
          </span>
        )}
      </div>

      <div className="main-body">
        {error && (
          <Banner
            text={error}
            action={
              <button
                className="primary"
                data-retry="highlights"
                aria-label="重试加载划线"
                onClick={load}
              >
                重试
              </button>
            }
            onClose={() => setError(null)}
          />
        )}

        {deleted && (
          <div
            role="status"
            aria-live="polite"
            data-undo-bar="1"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              marginBottom: 8,
              fontSize: 12,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-elevated)",
            }}
          >
            <span>
              已删除 1 条划线
              {deleted.note ? "（含笔记）" : ""}
            </span>
            <span className="spacer" />
            <button className="ghost" data-undo="1" onClick={() => void undoRemove()}>
              撤销
            </button>
          </div>
        )}

        {items === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty
            title="还没有划线"
            hint="在文章里选中一段文字，就会出现「高亮 / 笔记」两个按钮。划线会跟着这篇文章一起保存，下次打开还在原处。"
          />
        ) : (
          <>
            {/* A few hundred highlights are unmanageable by scrolling alone. */}
            <div
              data-marks-search="1"
              style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}
            >
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索划线正文、笔记或来源"
                aria-label="搜索划线"
                data-search-input="1"
                style={{ flex: 1, minWidth: 120, padding: "5px 8px", fontSize: 12 }}
              />
              <button
                className={onlyNotes ? "on" : ""}
                data-only-notes="1"
                aria-pressed={onlyNotes}
                onClick={() => setOnlyNotes((v) => !v)}
                title="只看有笔记的划线"
                style={{ fontSize: 12, whiteSpace: "nowrap" }}
              >
                只看有笔记
              </button>
              {filtering && (
                <button
                  className="ghost"
                  data-clear-filters="1"
                  onClick={() => {
                    setQuery("");
                    setOnlyNotes(false);
                  }}
                  style={{ fontSize: 12 }}
                >
                  清除筛选
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <Empty title="没有匹配的划线" hint="换个关键词，或者关掉筛选看看全部。" />
            ) : (
              <div className="marks">
                {filtered.map((h) => {
                  const editing = editingId === h.id;
                  const confirming = confirmId === h.id;
                  return (
                    <div className="mark-row" key={h.id} data-mark-row={h.id}>
                      <div
                        className="mark-row-main"
                        onClick={() => {
                          // While the note is open or the delete is being
                          // confirmed, the row stops being a link to the article.
                          if (editing || confirming) return;
                          onOpen(h);
                        }}
                        {...rows.propsFor(`mark:${h.id}`, () => onOpen(h), {
                          label: `${h.title || h.url}：${preview(h.text, 60)}`,
                        })}
                      >
                        <blockquote className="mark-quote">{preview(h.text, 140)}</blockquote>

                        {editing ? (
                          <div data-note-editor="1" style={{ marginTop: 6 }}>
                            <textarea
                              value={draft}
                              autoFocus
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") cancelEdit();
                              }}
                              placeholder="写点什么…（留空保存＝清除笔记）"
                              aria-label="笔记内容"
                              data-note-input="1"
                              rows={3}
                              style={{ width: "100%", fontSize: 13, resize: "vertical" }}
                            />
                            {/* A failed save/clear is an error, not a hint:
                                --err keeps it readable on every theme. */}
                            {editError && (
                              <div data-note-error="1" style={{ color: "var(--err)", fontSize: 12 }}>
                                {editError}
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                              <button
                                className="primary"
                                data-note-save="1"
                                disabled={saving}
                                onClick={() => void saveNote(h)}
                              >
                                {saving ? "保存中…" : "保存"}
                              </button>
                              <button className="ghost" data-note-cancel="1" onClick={cancelEdit}>
                                取消
                              </button>
                            </div>
                          </div>
                        ) : (
                          h.note && <div className="mark-note">{h.note}</div>
                        )}

                        {confirming ? (
                          <div data-delete-confirm="1" style={{ marginTop: 6, fontSize: 12 }}>
                            <div data-delete-message="1">
                              {/* The note is the listener's own writing, so the
                                  warning has to name it — the same sentence for
                                  both cases would understate one of them. */}
                              {h.note
                                ? "删除这条划线？它上面的笔记也会一起删除，无法恢复。"
                                : "删除这条划线？删除后无法恢复。"}
                            </div>
                            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                              <button
                                className="primary"
                                data-delete-yes="1"
                                onClick={() => void remove(h)}
                              >
                                删除
                              </button>
                              <button
                                className="ghost"
                                data-delete-no="1"
                                onClick={() => setConfirmId(null)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : null}

                        <div className="mark-meta">
                          {h.title || h.url}
                          {h.source_name && ` · ${h.source_name}`}
                          {` · ${timeAgo(h.created_at)}`}
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {!editing && (
                          <button
                            className="ghost"
                            data-note-edit={h.id}
                            onClick={() => startEdit(h)}
                            title={h.note ? "编辑笔记" : "添加笔记"}
                            style={{ fontSize: 12 }}
                          >
                            {h.note ? "编辑笔记" : "+ 笔记"}
                          </button>
                        )}
                        {h.note && !editing && (
                          <button
                            className="ghost"
                            data-note-clear={h.id}
                            onClick={() => void clearNote(h)}
                            title="只清除笔记，保留这条划线"
                            style={{ fontSize: 12 }}
                          >
                            清除笔记
                          </button>
                        )}
                        {!confirming && (
                          <button
                            className="ghost"
                            title="删除这条划线"
                            aria-label={`删除划线 ${preview(h.text, 30)}`}
                            data-mark-delete={h.id}
                            onClick={() => {
                              setEditError(null);
                              setConfirmId(h.id);
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}