// @vitest-environment jsdom
//
// useWideEnough: whether an element has room, read from its border box. The
// Settings page shows its section index only where the page itself is wide
// enough (SetupView); these pin when the hook decides and what it reads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useWideEnough } from "./useWideEnough";

/** A box that shows a child unless the hook says it is narrow. */
function Box({ min = 720 }: { min?: number }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const wide = useWideEnough(el, min);
  return (
    <div
      ref={setEl}
      data-wide={String(wide)}
    >
      {wide !== false && <nav />}
    </div>
  );
}

let observed: Array<{ el: Element; options?: ResizeObserverOptions }> = [];
let disconnects = 0;
// deliver hands the observer's callback one entry, as a browser does,
// outside act. A report gives the border box and the content box (without a
// scrollbar).
let deliver: (entry: Record<string, unknown>) => void = () => {};
const reportNow = (border: number, content = border) =>
  deliver({
    borderBoxSize: [{ inlineSize: border, blockSize: 0 }],
    contentRect: { width: content },
  });
const report = (border: number, content?: number) =>
  act(() => reportNow(border, content));

beforeEach(() => {
  observed = [];
  disconnects = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        deliver = (entry) =>
          callback(
            [entry as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
      }
      observe(el: Element, options?: ResizeObserverOptions) {
        observed.push({ el, options });
      }
      unobserve() {}
      disconnect() {
        disconnects += 1;
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs `fn` the way a browser task would, outside act: what the DOM holds
 *  when it returns is what the browser would paint next. */
function outsideAct(fn: () => void) {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    fn();
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
}

/** jsdom lays nothing out: every element's border box reads this wide. */
function borderBox(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 0,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("useWideEnough", () => {
  // A browser paints after the task that commits. Rendered with flushSync
  // outside act, the DOM when flushSync returns is what a browser would
  // paint: React finishes its synchronous work (the ref's update, a layout
  // effect's update) inside it, while a passive effect's update comes later.
  it("decides in the commit that mounts the element, before a paint", () => {
    borderBox(500);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    outsideAct(() => {
      try {
        flushSync(() => root.render(<Box />));
        expect(host.querySelector("nav")).toBeNull();
      } finally {
        root.unmount();
        host.remove();
      }
    });
  });

  // An observer reports after layout and before paint, but an update from
  // its callback would wait for React's scheduler, after that paint. On the
  // Settings page the panels around it settle after it is measured, so a
  // 1024 px window showed the index for a frame. The report applies at once.
  it("applies an observer's report before the paint that follows it", () => {
    borderBox(800);
    const { container } = render(<Box />);
    expect(container.querySelector("nav")).toBeTruthy();
    outsideAct(() => {
      reportNow(500);
      expect(container.querySelector("nav")).toBeNull();
    });
  });

  // The observer reports fractions; offsetWidth would round 719.6 up to 720
  // and show the child for a frame.
  it("reads the border box with its fractions", () => {
    borderBox(719.6);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(720);
    const { container } = render(<Box />);
    expect(container.querySelector("nav")).toBeNull();
  });

  // A classic scrollbar (Windows, a mouse on macOS) is inside the border box,
  // so its coming and going changes nothing.
  it("follows the border box, not the content box", () => {
    borderBox(730);
    const { container } = render(<Box />);
    expect(container.querySelector("nav")).toBeTruthy();
    report(730, 715);
    expect(container.querySelector("nav")).toBeTruthy();
    report(700);
    expect(container.querySelector("nav")).toBeNull();
    report(720);
    expect(container.querySelector("nav")).toBeTruthy();
  });

  // Safari before 15.4 reports no borderBoxSize, Firefox 69 to 91 one object
  // instead of an array: the element's border box is read then, with its
  // fractions, and with a classic scrollbar's room.
  it("reads the element when a report has no border box list", () => {
    borderBox(800);
    const { container } = render(<Box />);
    expect(container.querySelector("nav")).toBeTruthy();
    borderBox(719.6);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(720);
    act(() => deliver({ contentRect: { width: 719.6 } }));
    expect(container.querySelector("nav")).toBeNull();
    borderBox(730);
    act(() =>
      deliver({
        borderBoxSize: { inlineSize: 730, blockSize: 0 },
        contentRect: { width: 715 },
      })
    );
    expect(container.querySelector("nav")).toBeTruthy();
  });

  it("observes the border box and stops when unmounted", () => {
    borderBox(800);
    const { container, unmount } = render(<Box />);
    expect(observed).toEqual([
      { el: container.firstChild, options: { box: "border-box" } },
    ]);
    unmount();
    expect(disconnects).toBe(1);
  });

  it("says nothing without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    borderBox(500);
    const { container } = render(<Box />);
    expect(container.firstElementChild?.getAttribute("data-wide")).toBe("null");
    expect(container.querySelector("nav")).toBeTruthy();
  });
});
