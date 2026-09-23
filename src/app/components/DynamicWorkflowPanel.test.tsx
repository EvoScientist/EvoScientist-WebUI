// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DynamicWorkflowPanel,
  DynamicWorkflowTrigger,
} from "./DynamicWorkflowPanel";
import type { WorkflowMap } from "@/lib/dynamicWorkflow";

function twoPhaseMap(secondRunning: boolean): WorkflowMap {
  return {
    call_a: {
      evalId: "call_a",
      updatedAt: 100,
      dispatches: [
        {
          id: "a1",
          label: "battle: one",
          subagentType: "task",
          description: "first battle",
          status: "done",
          startedAt: 0,
          durationMs: 1000,
        },
      ],
    },
    call_b: {
      evalId: "call_b",
      updatedAt: 200,
      dispatches: [
        {
          id: "b1",
          label: "refine: two",
          subagentType: "task",
          description: "",
          status: secondRunning ? "running" : "done",
          startedAt: 5000,
          durationMs: secondRunning ? undefined : 800,
        },
      ],
    },
  };
}

describe("DynamicWorkflowTrigger", () => {
  it("renders nothing without phases", () => {
    const { container } = render(
      <DynamicWorkflowTrigger
        workflows={{}}
        expanded={false}
        onClick={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows live progress and running label while running", () => {
    render(
      <DynamicWorkflowTrigger
        workflows={twoPhaseMap(true)}
        expanded={false}
        onClick={() => {}}
      />
    );
    expect(screen.getByText("Workflow 1/2")).toBeDefined();
    expect(screen.getByText("refine: two")).toBeDefined();
  });

  it("shows phase summary when idle and fires onClick", () => {
    const onClick = vi.fn();
    render(
      <DynamicWorkflowTrigger
        workflows={twoPhaseMap(false)}
        expanded={false}
        onClick={onClick}
      />
    );
    expect(screen.getByText("Dynamic workflow · 2 phases")).toBeDefined();
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("DynamicWorkflowPanel", () => {
  it("lists phases, auto-selects the running one, and switches on click", () => {
    render(<DynamicWorkflowPanel workflows={twoPhaseMap(true)} />);
    expect(screen.getByText("#1")).toBeDefined();
    expect(screen.getByText("#2")).toBeDefined();
    expect(screen.getByText("refine: two")).toBeDefined();
    expect(screen.queryByText("battle: one")).toBeNull();
    fireEvent.click(screen.getByText("#1"));
    expect(screen.getByText("battle: one")).toBeDefined();
    expect(screen.queryByText("refine: two")).toBeNull();
  });

  it("expands a row to reveal the description", () => {
    render(<DynamicWorkflowPanel workflows={twoPhaseMap(false)} />);
    fireEvent.click(screen.getByText("#1"));
    const row = screen.getByRole("button", { name: /battle: one/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("first battle")).toBeDefined();
  });
});

// Experts fan out through the same `task()` dispatch as any other sub-agent,
// and the backend's panel events carry no type flag — the only way to tell
// them apart is to check the name against the deployment's expert list.
describe("DynamicWorkflowPanel expert marking", () => {
  const mapWith = (subagentType: string): WorkflowMap => ({
    call_a: {
      evalId: "call_a",
      updatedAt: 100,
      dispatches: [
        {
          id: "a1",
          label: "review the draft",
          subagentType,
          description: "",
          status: "done",
          startedAt: 0,
          durationMs: 1000,
        },
      ],
    },
  });

  it("marks a dispatch whose name is an installed expert", () => {
    render(
      <DynamicWorkflowPanel
        workflows={mapWith("paper-review")}
        expertNames={new Set(["paper-review"])}
      />
    );
    expect(screen.getByTitle(/expert/i)).toBeTruthy();
  });

  it("leaves an ordinary sub-agent unmarked", () => {
    render(
      <DynamicWorkflowPanel
        workflows={mapWith("general-purpose")}
        expertNames={new Set(["paper-review"])}
      />
    );
    // Anchor first: the panel returns null when it has nothing to show, and
    // then "no expert marker" would pass for the wrong reason.
    expect(screen.getByText("general-purpose")).toBeTruthy();
    expect(screen.queryByTitle(/expert/i)).toBeNull();
  });

  it("marks nothing when the expert list has not loaded", () => {
    render(<DynamicWorkflowPanel workflows={mapWith("paper-review")} />);
    expect(screen.getByText("paper-review")).toBeTruthy();
    expect(screen.queryByTitle(/expert/i)).toBeNull();
  });
});
