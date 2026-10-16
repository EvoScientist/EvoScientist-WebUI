// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { ThemeProvider, ThemedToaster } from "./ThemeProvider";

describe("ThemedToaster", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
  });

  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
    vi.unstubAllGlobals();
  });

  // At the default bottom right, a toast covered the composer's Stop button.
  it("shows toasts at the top center, below the header", async () => {
    render(
      <ThemeProvider>
        <ThemedToaster />
      </ThemeProvider>
    );
    act(() => {
      toast("Saved");
    });

    const toaster = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-sonner-toaster]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(toaster.dataset.yPosition).toBe("top");
    expect(toaster.dataset.xPosition).toBe("center");
    const belowHeader = "calc(env(safe-area-inset-top) + 4rem)";
    expect(toaster.style.getPropertyValue("--offset-top")).toBe(belowHeader);
    expect(toaster.style.getPropertyValue("--mobile-offset-top")).toBe(
      belowHeader
    );
  });

  // Up there a toast can cover the inspector's tabs for a few seconds.
  it("gives toasts a close button", async () => {
    render(
      <ThemeProvider>
        <ThemedToaster />
      </ThemeProvider>
    );
    act(() => {
      toast("Saved");
    });

    const close = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-sonner-toast] [aria-label="Close toast"]'
      );
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(close);
    await waitFor(() =>
      expect(
        document.querySelector('[data-sonner-toast][data-removed="false"]')
      ).toBeNull()
    );
  });

  it.each([
    ["right", 95, 0],
    ["left", -95, 0],
    ["up", 0, -95],
  ])("dismisses a toast swiped %s", async (_direction, dx, dy) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // jsdom has no pointer capture, which sonner calls on pointer down.
    const hadCapture = "setPointerCapture" in Element.prototype;
    if (!hadCapture) Element.prototype.setPointerCapture = () => {};
    try {
      render(
        <ThemeProvider>
          <ThemedToaster />
        </ThemeProvider>
      );
      act(() => {
        toast("Saved");
      });
      const el = await waitFor(() => {
        const t = document.querySelector<HTMLElement>("[data-sonner-toast]");
        expect(t).toBeTruthy();
        return t!;
      });

      // A slow drag (one second), so only its length can dismiss the toast,
      // not its speed.
      const at = (x: number, y: number) => ({
        clientX: 100 + x,
        clientY: 100 + y,
        pointerId: 1,
      });
      fireEvent.pointerDown(el, at(0, 0));
      fireEvent.pointerMove(el, at(Math.sign(dx) * 5, Math.sign(dy) * 5));
      fireEvent.pointerMove(el, at(dx, dy));
      vi.setSystemTime(Date.now() + 1000);
      fireEvent.pointerUp(el, at(dx, dy));

      await waitFor(() => expect(el.dataset.swipeOut).toBe("true"));
    } finally {
      if (!hadCapture)
        delete (Element.prototype as Partial<Element>).setPointerCapture;
      vi.useRealTimers();
    }
  });
});
