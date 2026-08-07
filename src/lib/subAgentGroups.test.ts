import { describe, it, expect } from "vitest";
import { groupStepsForFold } from "@/lib/subAgentActivity";
import type { SubAgentStep } from "@/lib/subAgentActivity";

// Sub-agent step timelines vary — the shape below is representative of what
// `messagesToSubAgentSteps` emits for a typical async run: opening reasoning,
// a burst of tool activity, mid-turn reasoning, more tools, then the final
// answer text. The grouping rule is "text breaks the fold; consecutive
// non-text steps collect into one run".

function text(t: string): SubAgentStep {
  return { kind: "text", text: t };
}
function tc(id: string, name: string): SubAgentStep {
  return { kind: "tool_call", id, name, args: {} };
}
function tr(id: string, out: string): SubAgentStep {
  return { kind: "tool_result", toolCallId: id, name: "search", text: out };
}

describe("groupStepsForFold", () => {
  it("returns an empty list for an empty timeline", () => {
    expect(groupStepsForFold([])).toEqual([]);
  });

  it("wraps a single tool run between two text boundaries", () => {
    const steps: SubAgentStep[] = [
      text("opening"),
      tc("a", "search"),
      tr("a", "hit"),
      tc("b", "read"),
      tr("b", "body"),
      text("closing"),
    ];
    const groups = groupStepsForFold(steps);
    expect(groups.map((g) => g.kind)).toEqual(["text", "actions", "text"]);
    const actions = groups[1];
    if (actions.kind !== "actions") throw new Error("unreachable");
    expect(actions.steps).toHaveLength(4);
    expect(actions.startIndex).toBe(1);
  });

  it("splits into two action groups when text sits between them", () => {
    const steps: SubAgentStep[] = [
      tc("a", "search"),
      tr("a", "hit"),
      text("intermediate"),
      tc("b", "read"),
      tr("b", "body"),
    ];
    const groups = groupStepsForFold(steps);
    expect(groups.map((g) => g.kind)).toEqual(["actions", "text", "actions"]);
  });

  it("emits a single actions group when the timeline has no text at all", () => {
    const steps: SubAgentStep[] = [
      tc("a", "search"),
      tr("a", "hit"),
      tc("b", "read"),
      tr("b", "body"),
    ];
    const groups = groupStepsForFold(steps);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("actions");
  });

  it("emits only text items when the timeline has no tool activity", () => {
    const steps: SubAgentStep[] = [text("a"), text("b")];
    const groups = groupStepsForFold(steps);
    expect(groups.map((g) => g.kind)).toEqual(["text", "text"]);
  });

  it("respects dropIndex — skips the specified trailing text step", () => {
    const steps: SubAgentStep[] = [
      tc("a", "search"),
      tr("a", "hit"),
      text("final"),
    ];
    // dropIndex = 2 mirrors hideFinalText: the trailing text is rendered
    // elsewhere (as the task Output), so it must not appear in the fold.
    const groups = groupStepsForFold(steps, 2);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("actions");
  });
});
