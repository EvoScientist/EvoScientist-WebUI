import { vi } from "vitest";

/**
 * jsdom runs no CSS animation, so Radix's Presence unmounts a closed dialog at
 * once. This gives a dialog's content and overlay an animation name per state,
 * as the shadcn classes do in a browser, so a closed dialog stays on the page
 * (`data-state="closed"`, fading out) until its animationend, about 200 ms
 * there. A stubbed global, so `vi.unstubAllGlobals()` takes it away.
 */
export function animateDialogs() {
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (el: Element, pseudo?: string | null) => {
    const style = real(el, pseudo);
    if (
      !(el instanceof HTMLElement) ||
      !el.matches('[data-slot="dialog-content"], [data-slot="dialog-overlay"]')
    ) {
      return style;
    }
    return new Proxy(style, {
      get(target, prop) {
        if (prop === "animationName") {
          return el.getAttribute("data-state") === "closed" ? "exit" : "enter";
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
}

/** A dialog's words as shown, open or fading out: title, sentences and the
 *  footer's buttons. */
export function dialogWords(dialog: HTMLElement) {
  return {
    title: dialog.querySelector('[data-slot="dialog-title"]')?.textContent,
    description: dialog.querySelector('[data-slot="dialog-description"]')
      ?.textContent,
    buttons: Array.from(
      dialog.querySelectorAll('[data-slot="dialog-footer"] button')
    ).map((b) => b.textContent),
  };
}
