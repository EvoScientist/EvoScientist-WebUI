// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows a sub-agent's file edit as a compact diff", () => {
    render(
      <SubAgentSteps
        compact
        steps={[
          {
            kind: "tool_call",
            id: "e1",
            name: "edit_file",
            args: { file_path: "/ws/a.py", old_string: "a", new_string: "b" },
          },
          {
            kind: "tool_result",
            toolCallId: "e1",
            name: "edit_file",
            text: "Successfully replaced 1 instance(s) of the string in '/ws/a.py'",
          },
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^edit_file/ }));

    expect(screen.getByRole("list", { name: "Changes" }).className).toContain(
      "text-[11px]"
    );
  });

  it("shows a step that failed as failed, with its args", () => {
    render(
      <SubAgentSteps
        steps={[
          {
            kind: "tool_call",
            id: "e1",
            name: "edit_file",
            args: { file_path: "/ws/a.py", old_string: "a", new_string: "b" },
          },
          {
            kind: "tool_result",
            toolCallId: "e1",
            name: "edit_file",
            text: "Error: String not found",
            failed: true,
          },
        ]}
      />
    );
    expect(screen.getByLabelText("Failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /edit_file/ }));
    expect(screen.queryByRole("list", { name: "Changes" })).toBeNull();
    expect(screen.getByText("old_string:")).toBeTruthy();
  });

  it("shows a call's later successful result as completed", () => {
    const { container } = render(
      <SubAgentSteps
        steps={[
          {
            kind: "tool_call",
            id: "r1",
            name: "execute",
            args: { command: "ls" },
          },
          {
            kind: "tool_result",
            toolCallId: "r1",
            name: "execute",
            text: "Error: busy",
            failed: true,
          },
          {
            kind: "tool_result",
            toolCallId: "r1",
            name: "execute",
            text: "a.txt",
          },
        ]}
      />
    );
    expect(screen.queryByLabelText("Failed")).toBeNull();
    expect(screen.queryByLabelText("Did not finish")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /execute/ }));
    expect(screen.getByText("a.txt")).toBeTruthy();
  });
});
