// @vitest-environment jsdom
//
// useOverflowing: whether an element's content is taller than its box. A
// scroll box is a Tab stop only while it has something to scroll (a goal's
// review in ask_user, the "Not sent" notice's list): Safari can't scroll one
// with the keyboard otherwise, and a short one would be a stop for nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { useOverflowing } from "./useOverflowing";

function Box() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const overflowing = useOverflowing(el);
  return (
    <div
      ref={setEl}
      data-overflowing={String(overflowing)}
    />
  );
}

// Like a browser, the observer reports only on the elements it observes.
let report: () => void = () => {};
let observed: Element[] = [];
let disconnects = 0;

beforeEach(() => {
  observed = [];
  disconnects = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        report = () => {
          const entries = observed.map(
            (target) => ({ target } as ResizeObserverEntry)
          );
          if (entries.length > 0) {
            act(() => callback(entries, this as unknown as ResizeObserver));
          }
        };
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {
        disconnects += 1;
        observed = [];
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom lays nothing out: every element's content and box read this tall. */
function heights(content: number, box: number) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    content
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(box);
}

const state = (container: HTMLElement) =>
  container.firstElementChild?.getAttribute("data-overflowing");

describe("useOverflowing", () => {
  it("reads the content against the box when mounted", () => {
    heights(300, 120);
    const { container } = render(<Box />);
    expect(state(container)).toBe("true");
  });

  it("says no when everything fits", () => {
    heights(120, 120);
    const { container } = render(<Box />);
    expect(state(container)).toBe("false");
  });

  it("reads again when the box changes size", () => {
    heights(300, 120);
    const { container } = render(<Box />);
    expect(observed).toEqual([container.firstElementChild]);
    heights(300, 320);
    report();
    expect(state(container)).toBe("false");
    heights(300, 200);
    report();
    expect(state(container)).toBe("true");
  });

  it("stops when unmounted", () => {
    heights(300, 120);
    const { unmount } = render(<Box />);
    unmount();
    expect(disconnects).toBe(1);
  });

  it("says nothing without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    heights(120, 120);
    const { container } = render(<Box />);
    expect(state(container)).toBe("null");
  });
});
