// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolCallBox } from "./ToolCallBox";
import type { ToolCall } from "@/app/types/types";

const toolCall: ToolCall = {
  id: "tc1",
  name: "execute",
  args: { command: "ls" },
  status: "interrupted",
};
const actionRequest = { name: "execute", args: { command: "ls" } };
const noop = () => {};
const approvalCard = () =>
  screen.queryByRole("region", { name: /^Approval required/ });

describe("ToolCallBox approval expansion", () => {
  it("opens the approval card for a request that needs a human", () => {
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={false}
      />
    );
    expect(approvalCard()).not.toBeNull();
  });

  it("keeps the card closed while the interrupt resolves without the user", () => {
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={true}
      />
    );
    expect(approvalCard()).toBeNull();
  });

  it("stays openable by hand while auto-resolving, so a swallowed resume cannot lock the user out", () => {
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={true}
      />
    );
    expect(approvalCard()).toBeNull();
    // The header is the only button while the box is collapsed.
    fireEvent.click(screen.getByRole("button"));
    expect(approvalCard()).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("opens once the deployment hands the decision back to the user", () => {
    // The request is already on screen while the policy is being checked; the
    // card has to open when the answer is "a human must decide", not only at
    // the moment the request first appears.
    const { rerender } = render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={true}
      />
    );
    expect(approvalCard()).toBeNull();
    rerender(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        approvalAutoResolves={false}
      />
    );
    expect(approvalCard()).not.toBeNull();
  });

  it("falls back to the local auto-approve policy when no verdict is passed", () => {
    const { unmount } = render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        autoApprove={true}
      />
    );
    expect(approvalCard()).toBeNull();
    unmount();
    render(
      <ToolCallBox
        toolCall={toolCall}
        actionRequest={actionRequest}
        onResume={noop}
        autoApprove={false}
      />
    );
    expect(approvalCard()).not.toBeNull();
  });
});
