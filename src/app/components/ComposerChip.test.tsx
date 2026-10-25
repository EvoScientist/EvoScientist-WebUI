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
  delete (Element.prototype as { animate?: unknown }).animate;
  document.body.innerHTML = "";
});

/** Web Animations that never run: each records its keyframes and is
 *  finished (or not) by the test. */
function stubAnimate() {
  const made: Array<{
    target: Element;
    keyframes: Keyframe[];
    cancel: ReturnType<typeof vi.fn>;
    finish: () => void;
  }> = [];
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[]) {
      const animation = {
        onfinish: null as null | (() => void),
        cancel: vi.fn(),
      };
      made.push({
        target: this,
        keyframes,
        cancel: animation.cancel,
        finish: () => animation.onfinish?.(),
      });
      return animation;
    },
  });
  return made;
}

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

  // Live check at 320 px: a long skill name's chip at 16rem left the box
  // beside it 10 px of text, a letter a line. It takes half its row at most.
  it("takes half of its row at most, leaving room to type", () => {
    const { container } = render(
      <ComposerChip
        chip={{
          kind: "skill",
          name: "research-literature-survey-with-citations-and-summaries",
        }}
        onRemove={() => {}}
      />
    );
    const chip = container.querySelector('[data-slot="composer-chip"]')!;
    expect(chip.className.split(" ")).toContain("max-w-[min(16rem,50%)]");
  });

  it("pops in when it doesn't fly", () => {
    const { container } = render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={() => {}}
      />
    );
    const chip = container.querySelector('[data-slot="composer-chip"]')!;
    expect(chip.className).toContain("animate-in");
    expect(chip.getAttribute("data-kind")).toBe("skill");
  });

  // A sent or queued message's chip is there with its message: a thread
  // opened with its history doesn't pop every one.
  it("doesn't pop a static chip", () => {
    const { container } = render(
      <ComposerChip chip={{ kind: "skill", name: "paper-review" }} />
    );
    const chip = container.querySelector('[data-slot="composer-chip"]')!;
    expect(chip.className).not.toContain("animate-in");
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
      const animation = {
        onfinish: null as null | (() => void),
        cancel: () => {},
      };
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

  // Codex C4: a chip removed while another still folds takes a new element;
  // the old fold stops and doesn't clear the new one.
  it("stops its fold when it is unmounted, and doesn't say it has left", () => {
    const made = stubAnimate();
    const onLeft = vi.fn();
    const { unmount } = render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        leaving
        onLeft={onLeft}
      />
    );
    expect(made).toHaveLength(1);
    unmount();
    expect(made[0].cancel).toHaveBeenCalled();
    made[0].finish();
    expect(onLeft).not.toHaveBeenCalled();
  });

  // Agent #3: border-box padding and border kept a folded chip 14 px wide,
  // and the text jumped when it went. It folds to nothing, its gap too.
  it("folds its width, padding, border and gap to nothing", () => {
    const made = stubAnimate();
    render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        leaving
        onLeft={() => {}}
      />
    );
    const last = made[0].keyframes[made[0].keyframes.length - 1];
    expect(last).toMatchObject({
      width: "0px",
      paddingLeft: "0px",
      paddingRight: "0px",
      borderLeftWidth: "0px",
      borderRightWidth: "0px",
      marginRight: "0px",
    });
  });

  // Live, checkpoint B fix pass: a folding chip without its remove button
  // started 16 px narrower, and the text jumped before sliding. It keeps the
  // button's room (inert) for the fold.
  it("keeps its remove button's room while it folds", () => {
    const { container } = render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        leaving
        onLeft={() => {}}
      />
    );
    expect(screen.queryByRole("button")).toBeNull();
    const chip = container.querySelector("[data-kind]")!;
    expect(chip.querySelector('[data-slot="remove-room"]')).toBeTruthy();
    expect(chip.className.split(" ")).toContain("pr-0.5");
  });

  // Agent #4: the chip clipped its remove button's 44 px touch area to its
  // own 24 px. It clips only while it folds (the name truncates by itself).
  it("clips only while it folds, so its remove button's touch area reaches out", () => {
    const { container, rerender } = render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={() => {}}
      />
    );
    const classes = () =>
      container.querySelector("[data-kind]")!.className.split(" ");
    expect(classes()).not.toContain("overflow-hidden");
    rerender(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        leaving
        onLeft={() => {}}
      />
    );
    expect(classes()).toContain("overflow-hidden");
  });

  // Agent #5: only a chip just picked flies; one that comes back later
  // (typed again, handed back) doesn't fly from the old row again.
  it("flies only from where it was when it appeared", () => {
    const made = stubAnimate();
    const { rerender } = render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={() => {}}
      />
    );
    rerender(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={() => {}}
        flyFrom={rect(60, 700)}
      />
    );
    expect(made).toHaveLength(0);
    document.body.innerHTML = "";
    const flying = render(
      <ComposerChip
        chip={{ kind: "skill", name: "evo-memory" }}
        onRemove={() => {}}
        flyFrom={rect(60, 700)}
      />
    );
    expect(made).toHaveLength(1);
    flying.rerender(
      <ComposerChip
        chip={{ kind: "skill", name: "evo-memory" }}
        onRemove={() => {}}
      />
    );
    // Its flight goes on: clearing flyFrom after the mount doesn't land it.
    expect(document.querySelector('[data-ghost="composer-chip"]')).toBeTruthy();
    expect(made).toHaveLength(1);
  });

  // Agent nit: the ghost is a copy, remove button and all: out of reach.
  it("keeps the flying ghost out of reach", () => {
    stubAnimate();
    render(
      <ComposerChip
        chip={{ kind: "skill", name: "paper-review" }}
        onRemove={() => {}}
        flyFrom={rect(60, 700)}
      />
    );
    const ghost = document.querySelector('[data-ghost="composer-chip"]')!;
    expect(ghost.hasAttribute("inert")).toBe(true);
  });

  // Agent #11: while the composer can't be used, neither can the chip.
  it("disables its remove button when told", () => {
    render(
      <ComposerChip
        chip={{ kind: "goal" }}
        onRemove={() => {}}
        disabled
      />
    );
    expect(
      screen
        .getByRole("button", { name: "Leave goal mode" })
        .hasAttribute("disabled")
    ).toBe(true);
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
