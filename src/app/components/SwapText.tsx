"use client";

import React, { useLayoutEffect, useRef, useState } from "react";
import { canAnimate, prefersReducedMotion } from "@/lib/motion";

// How long the old text fades out, and the new one in.
const OUT_MS = 90;
const IN_MS = 150;

/** Whether this page can run Web Animations and the user wants motion. */
const motionOn = () =>
  typeof document !== "undefined" &&
  canAnimate(document.body) &&
  !prefersReducedMotion();

/**
 * A label that fades out and back in when it changes (the send button's,
 * the model's, the goal's): what shows lags `text` by the fade out. Without
 * motion it changes at once.
 */
export function SwapText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(text);
  const animate = motionOn();

  // Out: the old text fades, then the new one takes its place (the fade
  // lets go as it does, before the new text fades in). A text changed back
  // meanwhile stops the fade and stays.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!animate || !el || !canAnimate(el) || shown === text) return;
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: OUT_MS,
      easing: "ease-in",
      fill: "forwards",
    });
    fade.onfinish = () => setShown(text);
    return () => {
      fade.onfinish = null;
      fade.cancel();
    };
  }, [animate, shown, text]);

  // In: once the new text shows, it fades up.
  const prev = useRef(shown);
  useLayoutEffect(() => {
    if (prev.current === shown) return;
    prev.current = shown;
    const el = ref.current;
    if (!el || !canAnimate(el) || !motionOn()) return;
    el.animate(
      [
        { opacity: 0, transform: "translateY(2px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: IN_MS, easing: "ease-out" }
    );
  }, [shown]);

  return (
    <span
      ref={ref}
      className={className}
    >
      {animate ? shown : text}
    </span>
  );
}
