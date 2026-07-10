// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolApprovalInterrupt } from "./ToolApprovalInterrupt";
import {
  executeActionRequest,
  actionRequestWithDescription,
} from "@/test/fixtures/actionRequests";
import {
  clickApprove,
  clickEdit,
  clickReject,
  clickSaveApprove,
  confirmReject,
  getApproveButton,
  getEditButton,
  getRejectButton,
  setEditedArg,
  typeRejectionMessage,
} from "@/test/interactions/approvalCard";

describe("ToolApprovalInterrupt", () => {
  it("renders the approval header, tool name, and args", () => {
    const onResume = vi.fn();
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest("ls -la")}
        onResume={onResume}
      />
    );
    expect(screen.getByText(/approval required/i)).toBeDefined();
    expect(screen.getByText("execute")).toBeDefined();
    // Args block is a <pre> with JSON-formatted content.
    expect(container.textContent).toContain("ls -la");
  });

  it("renders the description when one is provided", () => {
    render(
      <ToolApprovalInterrupt
        actionRequest={actionRequestWithDescription()}
        onResume={vi.fn()}
      />
    );
    expect(screen.getByText(/save the draft to the workspace/i)).toBeDefined();
  });

  it("Approve fires onResume with an approve decision", () => {
    const onResume = vi.fn();
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        onResume={onResume}
      />
    );
    clickApprove(container);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith({
      decisions: [{ type: "approve" }],
    });
  });

  it("Reject first click reveals the rejection message input, second confirms", () => {
    const onResume = vi.fn();
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        onResume={onResume}
      />
    );
    clickReject(container);
    // Now the confirm-reject button + textarea are visible.
    expect(onResume).not.toHaveBeenCalled();
    expect(
      screen.getByPlaceholderText(/explain why you're rejecting/i)
    ).toBeDefined();

    typeRejectionMessage(container, "not now");
    confirmReject(container);

    expect(onResume).toHaveBeenCalledWith({
      decisions: [{ type: "reject", message: "not now" }],
    });
  });

  it("Reject with an empty message still fires a reject decision (trimmed)", () => {
    const onResume = vi.fn();
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        onResume={onResume}
      />
    );
    clickReject(container);
    confirmReject(container);
    expect(onResume).toHaveBeenCalledWith({
      decisions: [{ type: "reject", message: "" }],
    });
  });

  it("Edit reveals arg textareas; Save & Approve fires an edit decision with new args", () => {
    const onResume = vi.fn();
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest("ls")}
        onResume={onResume}
      />
    );
    clickEdit(container);
    // Now the textarea for the `command` arg is visible.
    setEditedArg(container, "command", "ls -la");
    clickSaveApprove(container);
    expect(onResume).toHaveBeenCalledWith({
      decisions: [
        {
          type: "edit",
          edited_action: {
            name: "execute",
            args: { command: "ls -la" },
          },
        },
      ],
    });
  });

  it("filters buttons by allowedDecisions from reviewConfig", () => {
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        reviewConfig={{ allowedDecisions: ["approve"] }}
        onResume={vi.fn()}
      />
    );
    expect(getApproveButton(container)).toBeDefined();
    expect(() => getRejectButton(container)).toThrow();
    expect(() => getEditButton(container)).toThrow();
  });

  it("accepts snake_case `allowed_decisions` too (backend uses the Python casing)", () => {
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        reviewConfig={{ allowed_decisions: ["reject"] }}
        onResume={vi.fn()}
      />
    );
    expect(getRejectButton(container)).toBeDefined();
    expect(() => getApproveButton(container)).toThrow();
  });

  it("hides the entire card once a decision has been submitted (submitted latch)", () => {
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        onResume={vi.fn()}
      />
    );
    clickApprove(container);
    // The component returns null after submit; the card is gone from the DOM.
    expect(container.querySelector("*")).toBeNull();
  });

  it("fires onSubmitted before onResume so the parent can flip UI state atomically", () => {
    const order: string[] = [];
    const onSubmitted = vi.fn(() => order.push("onSubmitted"));
    const onResume = vi.fn(() => order.push("onResume"));
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        onResume={onResume}
        onSubmitted={onSubmitted}
      />
    );
    clickApprove(container);
    expect(order).toEqual(["onSubmitted", "onResume"]);
  });

  it("disables all buttons and shows loading labels while isLoading is true", () => {
    const { container } = render(
      <ToolApprovalInterrupt
        actionRequest={executeActionRequest()}
        onResume={vi.fn()}
        isLoading
      />
    );
    const approve = getApproveButton(container);
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(approve.textContent?.toLowerCase()).toContain("approving");
    expect(getRejectButton(container).hasAttribute("disabled")).toBe(true);
    expect(getEditButton(container).hasAttribute("disabled")).toBe(true);
  });
});
