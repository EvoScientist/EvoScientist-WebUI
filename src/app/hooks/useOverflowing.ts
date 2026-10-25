import { useLayoutEffect, useState } from "react";

/**
 * Whether `el`'s content is taller than its box: read before the first paint
 * (in the commit its ref starts) and again whenever the box changes size (a
 * window resize, a max-height in vh). For content that doesn't change while
 * it is shown. null until measured, or without ResizeObserver.
 */
export function useOverflowing(el: HTMLElement | null): boolean | null {
  const [overflowing, setOverflowing] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setOverflowing(el.scrollHeight > el.clientHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return overflowing;
}
