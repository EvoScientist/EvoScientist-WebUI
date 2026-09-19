// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubAgentSteps } from "./SubAgentSteps";
import type { SubAgentStep } from "@/lib/subAgentActivity";

const steps: SubAgentStep[] = [
  { kind: "tool_call", id: "c1", name: "execute", args: { command: "ls" } },
  { kind: "tool_result", toolCallId: "c1", name: "execute", text: "a.txt" },
  {
    kind: "tool_call",
    id: "c2",
    name: "execute",
    args: { command: "sleep 600" },
  },
];

describe("SubAgentSteps", () => {
  it("spins on an unanswered step while the sub-agent is running", () => {
    const { container } = render(<SubAgentSteps steps={steps} />);
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("shows an unanswered step as stopped once the sub-agent is not running", () => {
    const { container } = render(
      <SubAgentSteps
        steps={steps}
        running={false}
      />
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.getAllByLabelText("Did not finish")).toHaveLength(1);
  });
});
