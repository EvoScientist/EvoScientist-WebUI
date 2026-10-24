// Motion the WebUI draws with the Web Animations API: never where the user
// asked the system for less motion, and never where the browser can't (jsdom).
// CSS transitions need nothing: globals.css cuts them to nothing for
// `prefers-reduced-motion: reduce`.

/** Whether the user asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    !!matchMedia("(prefers-reduced-motion: reduce)")?.matches
  );
}

/** Whether `el` can run a Web Animations API animation. */
export function canAnimate(
  el: Element | null
): el is Element & { animate: Element["animate"] } {
  return !!el && typeof (el as { animate?: unknown }).animate === "function";
}
