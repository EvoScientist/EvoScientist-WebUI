"use client";

import { useEffect, useRef, type FocusEvent, type MouseEvent } from "react";

// Keeping the focus on the drafts page when what held it turns off or goes
// (a decision under way, a re-read, a draft that left the list).

/** Focus the first of `targets` that takes it, without scrolling. */
export function focusFirst(
  targets: ReadonlyArray<HTMLElement | null | undefined>
) {
  for (const el of targets) {
    if (!el?.isConnected || (el as HTMLButtonElement).disabled) continue;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return;
  }
}

export type BoxState = "usable" | "disabled" | "gone";

/** A box whose buttons can turn off (a decision under way, a re-read) or go
 *  (the selection emptied, the open draft left the list) under the focus.
 *  When they do while the focus was in the box and the page lost it, the
 *  focus moves to the first of `fallback(box)` that takes it. Spread the
 *  result on the box. */
export function useFocusFallback(
  state: BoxState,
  fallback: (
    box: HTMLDivElement | null
  ) => ReadonlyArray<HTMLElement | null | undefined>
) {
  const ref = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const last = useRef(state);
  useEffect(() => {
    const before = last.current;
    last.current = state;
    if (before === state || state === "usable") return;
    if (!hadFocus.current) return;
    const active = document.activeElement as HTMLButtonElement | null;
    const lost =
      !active ||
      active === document.body ||
      (!!ref.current?.contains(active) && active.disabled);
    if (!lost) {
      hadFocus.current = !!active && !!ref.current?.contains(active);
      return;
    }
    hadFocus.current = false;
    focusFirst(fallback(ref.current));
  });
  return {
    ref,
    onFocus: () => {
      hadFocus.current = true;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      // Focus left the box, for the page itself too. Only a button that
      // turned off (a decision under way) or went loses it without the
      // user; then the box still gives it back.
      const from = e.target as Element;
      const off = from instanceof HTMLButtonElement && from.disabled;
      if (!next && (off || !from.isConnected)) return;
      hadFocus.current = false;
    },
    // Safari doesn't focus a clicked button; a click on plain text takes
    // no focus, so it doesn't count.
    onClick: (e: MouseEvent<HTMLElement>) => {
      if ((e.target as Element).closest("button")) hadFocus.current = true;
    },
  };
}
