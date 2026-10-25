import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Whether `el`'s border box is at least `min` px wide. Decided in the commit
 * that mounts it, before the browser paints (a layout effect, whose update
 * React applies at once), then followed with a ResizeObserver, whose reports
 * also apply before the paint that follows them. null until measured, or
 * without ResizeObserver.
 *
 * The border box holds a classic scrollbar (Windows, a mouse on macOS), which
 * comes and goes with the content's height. Where what `el` shows changes
 * that height (the Settings page's section index makes the form beside it
 * narrower and taller), a content-box reading could flip the answer every
 * frame near `min`. It is read with its fractions, as the observer reports
 * it; offsetWidth would round.
 */
export function useWideEnough(
  el: HTMLElement | null,
  min: number
): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = (width: number) => setWide(width >= min);
    read(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // An array in current browsers; a single object in Firefox 69 to 91,
      // missing before Safari 15.4.
      const width =
        entry.borderBoxSize?.[0]?.inlineSize ??
        el.getBoundingClientRect().width;
      // The observer reports after layout and before paint, while a plain
      // update would wait for React's scheduler, after that paint: the panels
      // around the Settings page settle after it is measured, and the index
      // showed for a frame. (A report that changes nothing renders nothing.)
      flushSync(() => read(width));
    });
    observer.observe(el, { box: "border-box" });
    return () => observer.disconnect();
  }, [el, min]);
  return wide;
}
