// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ComposerChip } from "./ComposerChip";

const rect = (left: number, top: number) =>
  ({
    left,
    top,
    width: 80,
    height: 24,
    right: left + 80,
    bottom: top + 24,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ComposerChip", () => {
  it("names each kind and its remove button", () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={onRemove}
      />
    );
    expect(screen.getByText("paper-review")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove /paper-review" })
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
    rerender(
      <ComposerChip
        chip={{ kind: "goal" }}
        onRemove={onRemove}
      />
    );
    expect(screen.getByText("Goal")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Leave goal mode" })
    ).toBeTruthy();
    rerender(
      <ComposerChip
        chip={{ kind: "amend" }}
        onRemove={onRemove}
      />
    );
    expect(screen.getByText("Amend goal")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Leave amend mode" })
    ).toBeTruthy();
  });

  it("keeps the composer's focus when its button is pressed", () => {
    render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={() => {}}
      />
    );
    const button = screen.getByRole("button", { name: "Remove /paper-review" });
    expect(fireEvent.mouseDown(button)).toBe(false);
  });

  it("renders a static chip without a button", () => {
    render(<ComposerChip chip={{ kind: "skill", name: "paper-review" }} />);
    expect(screen.getByText("paper-review")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("pops in when it doesn't fly", () => {
    const { container } = render(
      <ComposerChip chip={{ kind: "skill", name: "paper-review" }} />
    );
    const chip = container.querySelector('[data-slot="composer-chip"]')!;
    expect(chip.className).toContain("animate-in");
    expect(chip.getAttribute("data-kind")).toBe("skill");
  });

  it("doesn't animate without the Web Animations API", () => {
    expect(() =>
      render(
        <ComposerChip
          chip={{ kind: "skill", name: "paper-review" }}
          onRemove={() => {}}
          flyFrom={rect(10, 100)}
        />
      )
    ).not.toThrow();
    expect(
      document.querySelectorAll('[data-slot="composer-chip"]')
    ).toHaveLength(1);
  });

  it("flies in from the menu row as a ghost, then shows itself", () => {
    const finish: Array<() => void> = [];
    const animate = vi.fn(() => {
      const animation = { onfinish: null as null | (() => void) };
      finish.push(() => animation.onfinish?.());
      return animation;
    });
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    try {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
          return this.getAttribute("data-slot") === "composer-chip"
            ? rect(20, 900)
            : rect(0, 0);
        }
      );
      const { container } = render(
        <ComposerChip
          chip={{ kind: "skill", name: "paper-review" }}
          onRemove={() => {}}
          flyFrom={rect(60, 700)}
        />
      );
      const chip = container.querySelector<HTMLElement>(
        '[data-slot="composer-chip"]'
      )!;
      expect(animate).toHaveBeenCalledTimes(1);
      const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
      expect(frames[0].transform).toContain("translate(40px, -200px)");
      // The ghost flies in the page; the chip waits hidden, and it doesn't
      // pop as well.
      const ghost = document.querySelector('[data-ghost="composer-chip"]');
      expect(ghost).toBeTruthy();
      expect(ghost!.getAttribute("aria-hidden")).toBe("true");
      expect(chip.style.visibility).toBe("hidden");
      expect(chip.className).not.toContain("animate-in");
      finish.forEach((f) => f());
      expect(document.querySelector('[data-ghost="composer-chip"]')).toBeNull();
      expect(chip.style.visibility).toBe("");
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  it("collapses when it leaves, then says it has left", () => {
    const finish: Array<() => void> = [];
    const animate = vi.fn(() => {
      const animation = { onfinish: null as null | (() => void) };
      finish.push(() => animation.onfinish?.());
      return animation;
    });
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    try {
      const onLeft = vi.fn();
      const { container } = render(
        <ComposerChip
          chip={{ kind: "skill", name: "paper-review" }}
          leaving
          onLeft={onLeft}
        />
      );
      const chip = container.querySelector(
        '[data-slot="composer-chip-leaving"]'
      );
      expect(chip?.getAttribute("aria-hidden")).toBe("true");
      expect(container.querySelector('[data-slot="composer-chip"]')).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
      expect(frames[frames.length - 1].width).toBe("0px");
      expect(onLeft).not.toHaveBeenCalled();
      finish.forEach((f) => f());
      expect(onLeft).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  it("leaves at once without the Web Animations API", () => {
    const onLeft = vi.fn();
    render(
      <ComposerChip
        chip={{ kind: "goal" }}
        leaving
        onLeft={onLeft}
      />
    );
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("doesn't fly when the user prefers reduced motion", () => {
    const animate = vi.fn();
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      render(
        <ComposerChip
          chip={{ kind: "skill", name: "paper-review" }}
          flyFrom={rect(60, 700)}
        />
      );
      expect(animate).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });
});
