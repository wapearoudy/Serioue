// Keyboard behaviour for a dialog: Escape closes it, focus goes in, focus
// stays in, and focus goes back where it came from.
//
// A modal that cannot be dismissed with Escape reads as a frozen app, and one
// that leaves focus in the page behind it is worse for a keyboard or screen
// reader user: they tab into controls that are visually covered and operate the
// background without knowing it.
//
// Shared because the repo has more than one dialog and they should not each
// invent a slightly different version.

import { useEffect, useRef, type RefObject } from "react";

/** Everything Tab can land on inside the dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  // Held in a ref so a new inline arrow on every render does not restart the
  // effect — which would steal focus back to the top mid-use.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (!node) return;

    // Focus the first thing in the dialog rather than the container: a focused
    // container announces the title but gives the user nowhere to go.
    const first = node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
    first.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      // Focus escaped (a click on the backdrop, a stray programmatic focus):
      // pull it back to the start rather than letting it roam behind the modal.
      if (!active || !node.contains(active)) {
        event.preventDefault();
        items[0].focus();
        return;
      }
      const edge = event.shiftKey ? items[0] : items[items.length - 1];
      if (active === edge) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // The opener gets the focus back, so closing a dialog does not dump the
      // user at the top of the document.
      if (opener && document.contains(opener)) opener.focus();
      else document.body.focus();
    };
  }, [ref]);
}