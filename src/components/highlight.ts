// Drawing stored highlights back into a freshly rendered article.
//
// The reader re-fetches the page every time it opens, so a highlight cannot be
// an offset into the DOM: it is the quoted text, matched again on load. That
// means this module has to survive whatever the source's HTML did to it —
// text split across several nodes, extra whitespace between inline tags, the
// same sentence appearing twice.

/** Collapses the whitespace a browser renders, so matching is not literal. */
function normalise(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * The readable text nodes under `root`, in document order.
 *
 * Script and style content is skipped, and so is anything already marked up by
 * a previous call — running this twice must not nest `<mark>` inside `<mark>`.
 */
function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const out: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    out.push(n as Text);
    n = walker.nextNode();
  }
  return out;
}

/**
 * Every kept character of the readable text, mapped to where it came from.
 *
 * `flat` is the text with whitespace removed; `map[i]` is the text node and
 * offset that character occupied in the original DOM. The two stay aligned, so
 * an index into `flat` can be turned back into a `(node, offset)` pair.
 */
function readable(root: HTMLElement): { flat: string; map: Array<{ node: Text; at: number }> } {
  let flat = "";
  const map: Array<{ node: Text; at: number }> = [];
  for (const node of textNodes(root)) {
    const value = node.nodeValue ?? "";
    let seen = 0;
    for (let k = 0; k < value.length; k++) {
      const ch = value[k];
      if (/\s/.test(ch)) continue;
      flat += ch;
      map.push({ node, at: k });
      seen++;
    }
    void seen;
  }
  return { flat, map };
}

/**
 * Wrap every occurrence of `text` under `root` in a `<mark>`.
 *
 * Returns how many were found. Zero is a normal outcome — the source may have
 * changed the wording since the passage was saved — so the caller shows the
 * highlight in its list rather than pretending it is on the page.
 */
export function paintHighlight(root: HTMLElement, text: string, id: string): number {
  const needle = normalise(text);
  if (!needle) return 0;

  // A sentence routinely straddles a `<strong>` or a link, so the match almost
  // never lands inside one text node. Rebuild the readable text after every
  // wrap, because each `<mark>` removes nodes from future matches.
  let painted = 0;
  for (;;) {
    const { flat, map } = readable(root);
    const at = flat.indexOf(needle);
    if (at < 0) return painted;
    const start = map[at];
    const end = map[at + needle.length - 1];
    if (!start || !end) return painted;

    const range = document.createRange();
    try {
      range.setStart(start.node, start.at);
      range.setEnd(end.node, end.at + 1);
    } catch {
      // The DOM shifted under us; stop rather than spin.
      return painted;
    }

    const mark = document.createElement("mark");
    mark.className = "reader-mark";
    mark.dataset.highlightId = id;
    // extractContents lifts whatever the range covers — one text node or a
    // dozen elements — and leaves the surrounding text where it was, which is
    // exactly what dragging across a selection does.
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    painted++;
  }
}

/** Remove every `<mark>` this module added, restoring the original text. */
export function clearHighlights(root: HTMLElement): void {
  root.querySelectorAll("mark.reader-mark").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  // Undo the text-node splitting extractContents leaves behind, so a re-run
  // starts from the same node layout as the first one.
  root.normalize();
}

/** A short, readable preview of a passage for a list row. */
export function preview(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}