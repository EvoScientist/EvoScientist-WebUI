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

  describe("reasoning", () => {
    const plain: SubAgentStep = {
      kind: "reasoning",
      text: "Look at **a.txt** first.",
      markdown: false,
    };

    it("shows the reasoning as a collapsed Thought row that opens", () => {
      render(
        <SubAgentSteps
          steps={[plain, { kind: "text", text: "Done." }]}
          running={false}
        />
      );
      const row = screen.getByRole("button", { name: "Thought" });
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText(plain.text)).toBeNull();

      fireEvent.click(row);
      expect(row.getAttribute("aria-expanded")).toBe("true");
      // Plain reasoning shows as written.
      expect(screen.getByText(plain.text)).toBeTruthy();
    });

    it("renders a reasoning summary as Markdown", () => {
      const { container } = render(
        <SubAgentSteps
          steps={[{ ...plain, markdown: true }]}
          running={false}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Thought" }));
      expect(container.querySelector("strong")?.textContent).toBe("a.txt");
    });

    it("says Thinking… while the reasoning is a running sub-agent's latest step", () => {
      render(<SubAgentSteps steps={[plain]} />);
      const label = screen.getByText("Thinking…");
      expect(label.className).toContain("thinking-shimmer");
    });

    it.each([
      [
        "a step follows it",
        [plain, { kind: "tool_call", id: "c1", name: "ls", args: {} }],
        true,
      ],
      ["the sub-agent has stopped", [plain], false],
    ] as [string, SubAgentStep[], boolean][])(
      "says Thought once %s",
      (_label, list, running) => {
        render(
          <SubAgentSteps
            steps={list}
            running={running}
          />
        );
        expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
        expect(screen.queryByText("Thinking…")).toBeNull();
      }
    );

    // MarkdownContent sets its own size, so the wrapper's alone didn't apply.
    it.each([
      ["plain reasoning", false],
      ["a reasoning summary", true],
    ])("opens %s to the compact text size in the board", (_label, markdown) => {
      const { container } = render(
        <SubAgentSteps
          compact
          steps={[{ ...plain, markdown }]}
          running={false}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Thought" }));
      const text = markdown
        ? container.querySelector("strong")!.closest("div")!
        : screen.getByText(plain.text);
      expect(text.classList.contains("text-xs")).toBe(true);
      expect(text.classList.contains("leading-5")).toBe(true);
      expect(text.classList.contains("text-sm")).toBe(false);
      // As in the chat, a summary's headings stay smaller than an answer's.
      if (markdown) {
        expect(text.classList.contains("[&_h1]:text-sm")).toBe(true);
      }
    });

    it("keeps the reasoning when the final text is shown as the output", () => {
      render(
        <SubAgentSteps
          steps={[plain, { kind: "text", text: "The answer." }]}
          running={false}
          hideFinalText
        />
      );
      expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
      expect(screen.queryByText("The answer.")).toBeNull();
    });
  });
});
