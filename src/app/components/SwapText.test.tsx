// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwapText } from "./SwapText";

// A label that changes (the send button's, the model's, the goal's) fades
// out and back in, as the prototype's swap() does: 90 ms out, 150 ms in.

type FakeAnimation = {
  keyframes: Keyframe[];
  onfinish: null | (() => void);
  cancel: ReturnType<typeof vi.fn>;
};

function stubAnimate() {
  const made: FakeAnimation[] = [];
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: (keyframes: Keyframe[]) => {
      const animation: FakeAnimation = {
        keyframes,
        onfinish: null,
        cancel: vi.fn(),
      };
      made.push(animation);
      return animation;
    },
  });
  return made;
}

afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
});

describe("SwapText", () => {
  it("shows a new text at once without the Web Animations API", () => {
    const { rerender } = render(<SwapText text="Send" />);
    rerender(<SwapText text="Set goal" />);
    expect(screen.getByText("Set goal")).toBeTruthy();
  });

  it("fades the old text out, then the new one in", () => {
    const made = stubAnimate();
    const { rerender } = render(<SwapText text="Send" />);
    expect(made).toHaveLength(0);
    rerender(<SwapText text="Set goal" />);
    // The old text stays while it fades out.
    expect(screen.getByText("Send")).toBeTruthy();
    expect(made).toHaveLength(1);
    expect(made[0].keyframes.map((k) => k.opacity)).toEqual([1, 0]);
    act(() => made[0].onfinish?.());
    expect(screen.getByText("Set goal")).toBeTruthy();
    expect(made).toHaveLength(2);
    expect(made[1].keyframes[0]).toMatchObject({ opacity: 0 });
    expect(made[1].keyframes[made[1].keyframes.length - 1]).toMatchObject({
      opacity: 1,
    });
    // The fade out lets go once the new text fades in.
    expect(made[0].cancel).toHaveBeenCalled();
  });

  it("stays on a text changed back before its fade ended", () => {
    const made = stubAnimate();
    const { rerender } = render(<SwapText text="Send" />);
    rerender(<SwapText text="Set goal" />);
    rerender(<SwapText text="Send" />);
    expect(screen.getByText("Send")).toBeTruthy();
    expect(made[0].cancel).toHaveBeenCalled();
    // The stopped fade's end swaps nothing.
    act(() => made[0].onfinish?.());
    expect(screen.getByText("Send")).toBeTruthy();
    expect(made).toHaveLength(1);
  });

  it("shows a new text at once when the user prefers reduced motion", () => {
    const made = stubAnimate();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { rerender } = render(<SwapText text="Send" />);
    rerender(<SwapText text="Set goal" />);
    expect(screen.getByText("Set goal")).toBeTruthy();
    expect(made).toHaveLength(0);
  });

  it("passes its class to the text", () => {
    render(
      <SwapText
        text="Send"
        className="hidden sm:inline"
      />
    );
    expect(screen.getByText("Send").className).toBe("hidden sm:inline");
  });
});
