// Keyboard access for rows that behave like buttons but are not written as
// `<button>`.
//
// A list of cards, source rows or chapter entries is naturally a list of `div`s
// or `li`s, and the mouse works on all of them — which is exactly how ten places
// in this app ended up unreachable from the keyboard. Turning each one into a
// real `<button>` would change their layout and their nested controls, so
// instead they stay what they are and gain what they were missing: a role, a tab
// stop, Enter/Space activation, a label a screen reader can read, and a focus
// ring that is actually visible.
//
// One hook for all of them, because ten hand-written copies of this is how the
// tenth one ends up subtly wrong.

import { useCallback, useState, type CSSProperties, type KeyboardEvent } from "react";

/**
 * The visible focus ring.
 *
 * Inline rather than in the stylesheet: the ring has to exist before the shared
 * stylesheet does, and an inline outline works in every theme without a second
 * source of truth.
 */
const RING: CSSProperties = {
  outline: "2px solid var(--accent)",
  outlineOffset: "-2px",
  borderRadius: "4px",
};

type RowProps = {
  role?: string;
  tabIndex: number;
  /** True for rows that expand, so the state is announced. */
  expanded?: boolean;
  onKeyDown: (e: KeyboardEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
  style?: CSSProperties;
};

/**
 * Props that make one row keyboard-operable.
 *
 * Call `propsFor` from inside a `.map`, not the hook: the hook itself is called
 * once per list, so the number of hooks does not change when the list grows.
 *
 * `role` defaults to `button`. Pass `"link"` for a row that navigates, or
 * `"listitem"` when the row is a container with its own control inside.
 */
export function useKeyboardRows() {
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const propsFor = useCallback(
    (
      key: string,
      onActivate: () => void,
      options: { role?: string; expanded?: boolean; label?: string } = {},
    ): RowProps & { "aria-label"?: string } => {
      const role = options.role ?? "button";
      return {
        role,
        tabIndex: 0,
        "aria-label": options.label,
        onKeyDown: (e: KeyboardEvent) => {
          // A control inside the row (a star, a remove button) handles its own
          // keys; without this, Enter on it would also fire the row's action.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            // Space scrolls the page otherwise, which reads as "nothing happened".
            e.preventDefault();
            onActivate();
          }
        },
        onFocus: () => setFocusedKey(key),
        onBlur: () => setFocusedKey((k) => (k === key ? null : k)),
        style: focusedKey === key ? RING : undefined,
        ...(options.expanded === undefined ? {} : { "aria-expanded": options.expanded }),
      } as RowProps & { "aria-label"?: string; "aria-expanded"?: boolean };
    },
    [focusedKey],
  );

  return { propsFor, ring: RING };
}