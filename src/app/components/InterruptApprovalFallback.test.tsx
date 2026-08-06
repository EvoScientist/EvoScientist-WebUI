// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InterruptApprovalFallback } from "@/app/components/InterruptApprovalFallback";

const requests = [
  { name: "execute", args: { command: "pwd" } },
  { name: "execute", args: { command: "ls" } },
];

describe("InterruptApprovalFallback", () => {
  it("shows the requesting sub-agent and one card per request", () => {
    render(
      <InterruptApprovalFallback
        actionRequests={requests}
        reviewConfigsMap={new Map()}
        requestedBy="research-agent"
        onResume={vi.fn()}
      />
    );
    expect(
      screen.getByText(/Approval requested by research-agent/)
    ).toBeDefined();
    expect(screen.getAllByText("Approval Required")).toHaveLength(2);
  });

  it("Reject on any card abandons the whole run once, submits no decision", () => {
    const onResume = vi.fn();
    const onAbort = vi.fn();
    render(
      <InterruptApprovalFallback
        actionRequests={requests}
        reviewConfigsMap={new Map()}
        onResume={onResume}
        onAbort={onAbort}
      />
    );
    // Rejecting is a whole-run abandon — one click on any card is enough, and no
    // per-request decision aggregation happens.
    const rejectButtons = screen.getAllByRole("button", { name: /^Reject/ });
    fireEvent.click(rejectButtons[0]);
    expect(onResume).not.toHaveBeenCalled();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("aggregates one decision per request before resuming once", () => {
    const onResume = vi.fn();
    render(
      <InterruptApprovalFallback
        actionRequests={requests}
        reviewConfigsMap={new Map()}
        onResume={onResume}
      />
    );
    const approveButtons = screen.getAllByRole("button", { name: /Approve/ });
    fireEvent.click(approveButtons[0]);
    expect(onResume).not.toHaveBeenCalled();
    const remaining = screen.getAllByRole("button", { name: /Approve/ });
    fireEvent.click(remaining[0]);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith({
      decisions: [{ type: "approve" }, { type: "approve" }],
    });
  });

  it("keeps collected decisions across rerenders with a content-equal fresh array", () => {
    const onResume = vi.fn();
    const { rerender } = render(
      <InterruptApprovalFallback
        actionRequests={requests.map((r) => ({ ...r, args: { ...r.args } }))}
        reviewConfigsMap={new Map()}
        onResume={onResume}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Approve/ })[0]);
    expect(onResume).not.toHaveBeenCalled();
    rerender(
      <InterruptApprovalFallback
        actionRequests={requests.map((r) => ({ ...r, args: { ...r.args } }))}
        reviewConfigsMap={new Map()}
        onResume={onResume}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Approve/ })[0]);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith({
      decisions: [{ type: "approve" }, { type: "approve" }],
    });
  });

  it("resumes immediately for a single request", () => {
    const onResume = vi.fn();
    render(
      <InterruptApprovalFallback
        actionRequests={[requests[0]]}
        reviewConfigsMap={new Map()}
        onResume={onResume}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onResume).toHaveBeenCalledWith({
      decisions: [{ type: "approve" }],
    });
  });

  it("shows a fresh approval for identical requests with a new interrupt id", () => {
    const onResume = vi.fn();
    const props = {
      actionRequests: [requests[0]],
      reviewConfigsMap: new Map(),
      onResume,
    };
    const { rerender } = render(
      <InterruptApprovalFallback
        {...props}
        interruptKey="interrupt-a"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();

    rerender(
      <InterruptApprovalFallback
        {...props}
        interruptKey="interrupt-b"
      />
    );
    expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined();
  });
});
