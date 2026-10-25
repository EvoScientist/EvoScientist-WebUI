// @vitest-environment jsdom
//
// The open thread's goal next to the model pill: its status in the TUI's
// status-bar words, and on opening what /goal show prints, plus the latest
// grading.
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { GoalPill } from "./GoalPill";
import type { GoalStatus, RubricVerdict, ThreadGoal } from "@/lib/goalState";

const goal = (status: GoalStatus, note: string | null = null): ThreadGoal => ({
  objective: "Write hello\ninto probe.txt",
  status,
  note,
  rubricId: "goal:abc",
  criteria: "- The file exists\n- It says hello",
});
const verdict: RubricVerdict = {
  result: "needs_revision",
  explanation: "The file is missing.",
  iteration: 0,
};

function pill(props: Partial<Parameters<typeof GoalPill>[0]> = {}) {
  const onOpenChange = vi.fn();
  const view = render(
    <GoalPill
      goal={null}
      busy={null}
      verdict={null}
      open={false}
      onOpenChange={onOpenChange}
      {...props}
    />
  );
  return { ...view, onOpenChange };
}

describe("GoalPill", () => {
  it("shows nothing without a goal or a goal step", () => {
    const { container } = pill();
    expect(container.innerHTML).toBe("");
  });

  it.each([
    ["active", "goal: active"],
    ["paused", "goal: paused"],
    ["blocked", "goal: blocked"],
    ["complete", "goal: done"],
  ] as const)("labels a %s goal %j", (status, label) => {
    pill({ goal: goal(status) });
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  });

  it("shows the drafting step before there is a goal, with nothing to open", () => {
    pill({ busy: "drafting" });
    const button = screen.getByRole("button", { name: "Drafting criteria…" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  // A rubric set without a goal (the TUI's /rubric) is graded too; its
  // results are toasts only.
  it("shows nothing while a rubric without a goal is graded", () => {
    const { container } = pill({ busy: "checking" });
    expect(container.innerHTML).toBe("");
  });

  it("fits its details in a window narrower than the panel", () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      value: 300,
      configurable: true,
    });
    try {
      pill({ goal: goal("active"), open: true });
      const panel = screen.getByRole("dialog", { name: "Goal" });
      expect(panel.style.left).toBe("8px");
      expect(panel.style.width).toBe("284px");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
      });
    }
  });

  // globals.css takes every button's border away (`button { border: none }`),
  // so the outline needs border-solid; the fill is the soft brand tint.
  it("draws as a pill: a brand outline on the soft brand fill", () => {
    pill({ goal: goal("active") });
    const button = screen.getByRole("button", { name: "goal: active" });
    const classes = button.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "border",
        "border-solid",
        "border-[var(--brand)]",
        "bg-[var(--brand-soft)]",
      ])
    );
    // Hover darkens the brand colour (lightens it in dark mode): fading the
    // whole pill took its text under 4.5:1.
    expect(classes).not.toContain("hover:opacity-80");
    expect(classes).toEqual(
      expect.arrayContaining([
        "enabled:hover:border-[var(--brand-hover)]",
        "enabled:hover:text-[var(--brand-hover)]",
      ])
    );
  });

  // A status that changes fades out and back in, like the composer's other
  // labels (SwapText).
  it("fades its label when the status changes", () => {
    const made: Array<{ onfinish: null | (() => void) }> = [];
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => {
        const animation = { onfinish: null, cancel: () => {} };
        made.push(animation);
        return animation;
      },
    });
    try {
      const { rerender, onOpenChange } = pill({ goal: goal("active") });
      rerender(
        <GoalPill
          goal={goal("paused")}
          busy={null}
          verdict={null}
          open={false}
          onOpenChange={onOpenChange}
        />
      );
      expect(screen.getByRole("button", { name: "goal: active" })).toBeTruthy();
      act(() => made[0].onfinish?.());
      expect(screen.getByRole("button", { name: "goal: paused" })).toBeTruthy();
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  it("shows a grading in progress over the goal's status", () => {
    pill({ goal: goal("active"), busy: "checking" });
    expect(screen.getByRole("button", { name: "Checking…" })).toBeTruthy();
  });

  it("opens and closes through its owner", () => {
    const { onOpenChange, rerender } = pill({ goal: goal("active") });
    const button = screen.getByRole("button", { name: "goal: active" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    rerender(
      <GoalPill
        goal={goal("active")}
        busy={null}
        verdict={null}
        open
        onOpenChange={onOpenChange}
      />
    );
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("shows what /goal show prints, and the latest grading", () => {
    pill({
      goal: goal("blocked", "Need the user's input."),
      verdict,
      open: true,
    });
    const panel = screen.getByRole("dialog", { name: "Goal" });
    expect(panel.textContent).toContain("Goal (blocked)");
    expect(panel.textContent).toContain("Blocked: Need the user's input.");
    expect(panel.textContent).toContain("Acceptance criteria:");
    expect(panel.textContent).toContain(
      "Acceptance criteria not yet satisfied: The file is missing."
    );
    const objective = screen.getByText(/Write hello/);
    expect(objective.textContent).toBe("Write hello\ninto probe.txt");
    expect(objective.className).toContain("whitespace-pre-wrap");
    const criteria = screen.getByText(/The file exists/);
    expect(criteria.textContent).toBe("- The file exists\n- It says hello");
    expect(criteria.className).toContain("whitespace-pre-wrap");
  });

  it("labels a complete goal's note as its result", () => {
    pill({
      goal: goal("complete", "Acceptance criteria satisfied."),
      open: true,
    });
    expect(screen.getByRole("dialog", { name: "Goal" }).textContent).toContain(
      "Result: Acceptance criteria satisfied."
    );
  });
});
