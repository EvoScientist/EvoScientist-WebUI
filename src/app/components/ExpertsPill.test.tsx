// @vitest-environment jsdom
//
// A read-only pointer to what the orchestrator can dispatch right now.
// Installing an expert is what makes it available — there is nothing to
// switch on — so this shows state and never asks for a decision.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ExpertsPill } from "./ExpertsPill";

const three = [
  { name: "paper-review", description: "Adversarial self-review." },
  { name: "arithmetic-checker", description: "Verifies arithmetic claims." },
  { name: "logic-auditor", description: "Audits reasoning." },
];

describe("ExpertsPill", () => {
  it("counts the experts the deployment can dispatch", () => {
    render(
      <ExpertsPill
        teams={three}
        onManage={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /3 experts/i })).toBeTruthy();
  });

  it("says one expert in the singular", () => {
    render(
      <ExpertsPill
        teams={three.slice(0, 1)}
        onManage={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /1 expert(?!s)/i })).toBeTruthy();
  });

  it("renders nothing when none are installed", () => {
    const { container } = render(
      <ExpertsPill
        teams={[]}
        onManage={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists them on click without leaving the conversation", () => {
    const onManage = vi.fn();
    render(
      <ExpertsPill
        teams={three}
        onManage={onManage}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /3 experts/i }));

    expect(screen.getByText("paper-review")).toBeTruthy();
    expect(screen.getByText("logic-auditor")).toBeTruthy();
    expect(screen.getByText("Audits reasoning.")).toBeTruthy();
    // Opening the list must not navigate on its own.
    expect(onManage).not.toHaveBeenCalled();
  });

  it("offers a way through to the full view", () => {
    const onManage = vi.fn();
    render(
      <ExpertsPill
        teams={three}
        onManage={onManage}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /3 experts/i }));
    fireEvent.click(screen.getByRole("button", { name: /manage in experts/i }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("closes the list again on a second click", () => {
    render(
      <ExpertsPill
        teams={three}
        onManage={vi.fn()}
      />
    );
    const trigger = screen.getByRole("button", { name: /3 experts/i });
    fireEvent.click(trigger);
    expect(screen.getByText("paper-review")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByText("paper-review")).toBeNull();
  });
});

describe("ExpertsPill in a short viewport", () => {
  it("never reaches above the top of the screen", () => {
    // The panel opens upward from a composer pinned to the bottom. On a short
    // window the list is taller than the space above the trigger, and without
    // a cap the header and first entries end up off-screen.
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `expert-${i}`,
      description: "…",
    }));
    render(
      <ExpertsPill
        teams={many}
        onManage={vi.fn()}
      />
    );
    const trigger = screen.getByRole("button", { name: /20 experts/i });
    // jsdom reports 0 for every rect, so drive the measurement directly.
    trigger.getBoundingClientRect = () =>
      ({ left: 40, top: 360, right: 140, bottom: 380 } as DOMRect);
    Object.defineProperty(window, "innerHeight", {
      value: 400,
      configurable: true,
    });

    fireEvent.click(trigger);

    const panel = document.querySelector("div.fixed") as HTMLElement;
    expect(panel).toBeTruthy();
    // 360px of room above the trigger, minus the margin the panel keeps.
    const cap = parseInt(panel.style.maxHeight || "0", 10);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(360);
  });
});
