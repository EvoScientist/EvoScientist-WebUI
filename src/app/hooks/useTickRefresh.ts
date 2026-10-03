"use client";

import { useEffect, useRef } from "react";

/**
 * Call `onRefresh` when `tick` has moved on and the view is on screen. A tick
 * that arrives while hidden is caught up the next time the view shows, so a
 * background tab re-reads once when it is opened, not on every tick.
 */
export function useTickRefresh(
  visible: boolean,
  tick: number,
  onRefresh: () => void
): void {
  const handled = useRef(tick);
  useEffect(() => {
    if (!visible || handled.current === tick) return;
    handled.current = tick;
    onRefresh();
  }, [visible, tick, onRefresh]);
}
