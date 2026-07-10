// @vitest-environment jsdom
//
// ActionGroup's job is to bundle a run of tool-call messages under a
// collapsible header. The interesting bit for us is the `hasPendingApproval`
// logic — it gates a collapsed-approval preview so the user can act without
// expanding the timeline. When auto-approve is on the preview is SKIPPED
// on purpose (each interrupt is auto-resumed within a single render tick,
// so surfacing the preview would flicker the section open per tool call).

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ActionGroup, type GroupedActionItem } from "./ActionGroup";
import { executeActionRequest } from "@/test/fixtures/actionRequests";

// Stub ChatMessage so we can assert what props ActionGroup passes without
// mounting the full message-rendering tree. Each stub renders a div with
// data attributes reflecting the props that matter here.
vi.mock("./ChatMessage", () => ({
  ChatMessage: (props: {
    message: { id: string };
    isStreaming: boolean;
    actionRequests?: unknown[];
    autoApprove: boolean;
  }) => (
    <div
      data-testid="chat-message"
      data-message-id={props.message.id}
      data-is-streaming={String(props.isStreaming)}
      data-action-request-count={props.actionRequests?.length ?? 0}
      data-auto-approve={String(props.autoApprove)}
    />
  ),
}));

// CompactionSummary appears only when a summarization event is set, and
// we're not testing that branch here.
vi.mock("./CompactionSummary", () => ({
  CompactionSummary: () => <div data-testid="compaction-summary" />,
}));

const makeItem = (
  id: string,
  toolNames: string[] = ["execute"]
): GroupedActionItem => ({
  message: {
    id,
    type: "ai",
    content: "",
    tool_calls: toolNames.map((name, i) => ({
      id: `${id}c${i}`,
      name,
      args: {},
    })),
  } as unknown as GroupedActionItem["message"],
  toolCalls: toolNames.map((name, i) => ({
    id: `${id}c${i}`,
    name,
    args: {},
    status: "pending" as const,
  })),
});

// Default props factory — every test overrides the interesting bits.
const defaultProps = (
  overrides: Partial<React.ComponentProps<typeof ActionGroup>> = {}
) => ({
  items: [makeItem("m1", ["execute"])],
  isStreaming: false,
  defaultCollapsed: true,
  isAtBottom: true,
  lastMessageId: "m1",
  isLoading: false,
  actionRequests: [],
  submittedActionRequestKeys: new Set<string>(),
  onActionRequestSubmitted: vi.fn(),
  reviewConfigsMap: null,
  stream: {},
  onResumeInterrupt: vi.fn(),
  graphId: "EvoScientist",
  onEditMessage: vi.fn(),
  autoApprove: false,
  subAgentSteps: {},
  ui: undefined,
  compactionAnchorId: null,
  summarizationEvent: null,
  ...overrides,
});

describe("ActionGroup header", () => {
  it("counts total tool calls across items, not the number of messages", () => {
    const { container } = render(
      <ActionGroup
        {...defaultProps({
          items: [
            makeItem("m1", ["execute", "read_file"]),
            makeItem("m2", ["write_file"]),
          ],
        })}
      />
    );
    // 2 tool calls in m1 + 1 in m2 = 3
    expect(within(container).getByText(/3 actions/i)).toBeDefined();
  });

  it("shows singular 'action' when count is exactly 1", () => {
    const { container } = render(<ActionGroup {...defaultProps()} />);
    // "1 action —" but never "1 actions".
    expect(container.textContent).toContain("1 action —");
    expect(container.textContent).not.toContain("1 actions");
  });

  it("names the last tool call in the header", () => {
    const { container } = render(
      <ActionGroup
        {...defaultProps({
          items: [makeItem("m1", ["execute", "write_file"])],
        })}
      />
    );
    expect(container.textContent).toContain("write_file");
  });

  it("says 'running' during isStreaming and 'last' when settled", () => {
    const streaming = render(
      <ActionGroup {...defaultProps({ isStreaming: true })} />
    );
    expect(streaming.container.textContent).toMatch(/running/i);
    streaming.unmount();

    const settled = render(
      <ActionGroup {...defaultProps({ isStreaming: false })} />
    );
    expect(settled.container.textContent).toMatch(/last:/i);
  });

  it("toggles open state on click", () => {
    const { container } = render(<ActionGroup {...defaultProps()} />);
    const header = within(container).getByRole("button", { name: /expand/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ActionGroup default open/collapsed state", () => {
  it("starts open when defaultCollapsed is false", () => {
    render(<ActionGroup {...defaultProps({ defaultCollapsed: false })} />);
    // The inline body renders a ChatMessage stub only when open.
    expect(screen.getAllByTestId("chat-message").length).toBeGreaterThan(0);
  });

  it("starts collapsed when defaultCollapsed is true", () => {
    render(<ActionGroup {...defaultProps({ defaultCollapsed: true })} />);
    // No inline body -> no ChatMessage stub. (The collapsed-preview only
    // renders under hasPendingApproval, which is false here.)
    expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
  });
});

describe("ActionGroup hasPendingApproval (auto-approve gate)", () => {
  const req = executeActionRequest();

  it("shows a collapsed-preview when actionRequests non-empty and lastMessageId is in this group", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: true,
          actionRequests: [req],
          lastMessageId: "m1",
          autoApprove: false,
        })}
      />
    );
    // Header is collapsed but a preview ChatMessage is rendered for the
    // approval-bearing item.
    const previews = screen.getAllByTestId("chat-message");
    expect(previews).toHaveLength(1);
    expect(previews[0].getAttribute("data-action-request-count")).toBe("1");
  });

  it("does NOT show a collapsed-preview when autoApprove is on (avoids per-tool flash)", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: true,
          actionRequests: [req],
          lastMessageId: "m1",
          autoApprove: true,
        })}
      />
    );
    // No preview — the auto-approve effect will handle the interrupt.
    expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
  });

  it("does NOT show a collapsed-preview when actionRequests is empty", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: true,
          actionRequests: [],
          lastMessageId: "m1",
          autoApprove: false,
        })}
      />
    );
    expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
  });

  it("does NOT show a collapsed-preview when lastMessageId is undefined", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: true,
          actionRequests: [req],
          lastMessageId: undefined,
          autoApprove: false,
        })}
      />
    );
    expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
  });

  it("does NOT show a collapsed-preview when lastMessageId belongs to a different group", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: true,
          actionRequests: [req],
          lastMessageId: "someone-elses-message",
          autoApprove: false,
        })}
      />
    );
    expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
  });

  it("hides the collapsed-preview when the section is already open", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: false, // -> starts open
          actionRequests: [req],
          lastMessageId: "m1",
          autoApprove: false,
        })}
      />
    );
    // Open -> only inline body ChatMessage(s) render (no duplicate preview).
    const previews = screen.getAllByTestId("chat-message");
    expect(previews).toHaveLength(1);
  });
});

describe("ActionGroup body rendering (open)", () => {
  it("passes actionRequests ONLY to the last-overall message", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: false, // open
          items: [makeItem("m1"), makeItem("m2")],
          lastMessageId: "m2",
          actionRequests: [executeActionRequest()],
        })}
      />
    );
    const messages = screen.getAllByTestId("chat-message");
    const byId = Object.fromEntries(
      messages.map((m) => [m.getAttribute("data-message-id"), m])
    );
    expect(byId["m1"].getAttribute("data-action-request-count")).toBe("0");
    expect(byId["m2"].getAttribute("data-action-request-count")).toBe("1");
  });

  it("marks only the last-overall message as isStreaming when the group is streaming", () => {
    render(
      <ActionGroup
        {...defaultProps({
          defaultCollapsed: false,
          isStreaming: true,
          items: [makeItem("m1"), makeItem("m2")],
          lastMessageId: "m2",
        })}
      />
    );
    const messages = screen.getAllByTestId("chat-message");
    const byId = Object.fromEntries(
      messages.map((m) => [m.getAttribute("data-message-id"), m])
    );
    expect(byId["m1"].getAttribute("data-is-streaming")).toBe("false");
    expect(byId["m2"].getAttribute("data-is-streaming")).toBe("true");
  });

  it("renders a bottom Collapse button when open", () => {
    render(<ActionGroup {...defaultProps({ defaultCollapsed: false })} />);
    expect(
      screen.getByRole("button", { name: /^collapse 1 action$/i })
    ).toBeDefined();
  });
});
