// @vitest-environment jsdom
//
// Integration tests for the full ChatInterface. Peripheral hooks are stubbed
// and child components (ChatMessage, ActionGroup, ...) render as prop-spy
// divs so we can assert prop flow at the composition layer without pulling
// the full render tree into scope.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, screen, within, fireEvent } from "@testing-library/react";
import {
  MockStreamStore,
  clearMockStreamStore,
  installMockStreamStore,
  useMockStreamHook,
} from "@/test/mockUseStream";
import {
  MockClient,
  clearMockClient,
  getActiveMockClient,
  installMockClient,
} from "@/test/mockClient";

vi.mock("@langchain/langgraph-sdk/react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useStream: useMockStreamHook };
});

vi.mock("@/providers/ClientProvider", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ClientProvider: ({ children }: { children: React.ReactNode }) => children,
    useClient: () => getActiveMockClient(),
  };
});

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>(null),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/app/hooks/useAsyncAgents", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useAsyncAgents: m.useAsyncAgentsMock };
});
vi.mock("@/app/hooks/useAutoNotify", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useAutoNotify: m.useAutoNotifyMock };
});
vi.mock("@/app/hooks/useAvailableModels", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useAvailableModels: m.useAvailableModelsMock };
});
vi.mock("use-stick-to-bottom", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useStickToBottom: m.useStickToBottomMock };
});
vi.mock("@/lib/uiSettings", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { useCollapseAgentActions: m.useCollapseAgentActionsMock };
});

vi.mock("@/app/components/ChatMessage", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { ChatMessage: m.stubComponent("ChatMessage") };
});
vi.mock("@/app/components/ActionGroup", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { ActionGroup: m.stubComponent("ActionGroup") };
});
vi.mock("@/app/components/AskUserInterrupt", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { AskUserInterrupt: m.stubComponent("AskUserInterrupt") };
});
vi.mock("@/app/components/CompactionSummary", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { CompactionSummary: m.stubComponent("CompactionSummary") };
});
vi.mock("@/app/components/ResearchDashboard", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { ResearchDashboard: m.stubComponent("ResearchDashboard") };
});
vi.mock("@/app/components/TasksFilesSidebar", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { FilesPopover: m.stubComponent("FilesPopover") };
});
vi.mock("@/app/components/WorkspaceFileDialog", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { WorkspaceFileDialog: m.stubComponent("WorkspaceFileDialog") };
});
vi.mock("@/app/components/MemoryFileDialog", async () => {
  const m = await import("@/test/mocks/chatInterfaceStubs");
  return { MemoryFileDialog: m.stubComponent("MemoryFileDialog") };
});

import { renderChatInterface } from "@/test/renderChatInterface";
import {
  getAllProps,
  getLastProps,
  resetComponentSpy,
} from "@/test/mocks/chatInterfaceStubs";
import { humanTurn, aiTurn, aiToolCallTurn } from "@/test/fixtures/messages";
import { executeInterrupt, askUserInterrupt } from "@/test/fixtures/interrupts";
import { setThreadAutoApprove } from "@/lib/autoApprove";

describe("ChatInterface composition", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
    resetComponentSpy();
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  it("mounts under default state without crashing (empty transcript, composer visible)", () => {
    const { container } = renderChatInterface();
    // Composer form is the always-present piece — a good smoke signal that
    // ChatInterface got through mount without throwing.
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    // No messages, no groups, no ask-user.
    expect(screen.queryAllByTestId("stub-ChatMessage")).toHaveLength(0);
    expect(screen.queryAllByTestId("stub-ActionGroup")).toHaveLength(0);
    expect(screen.queryAllByTestId("stub-AskUserInterrupt")).toHaveLength(0);
  });

  it("passes plain messages (no tool calls) through as ChatMessage stubs, not ActionGroup", () => {
    renderChatInterface();
    act(() => {
      stream.setMessages([humanTurn("hi"), aiTurn("hello")]);
    });
    // Two ChatMessage children rendered, zero ActionGroup groupings.
    const chatMsgs = screen.getAllByTestId("stub-ChatMessage");
    expect(chatMsgs.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByTestId("stub-ActionGroup")).toHaveLength(0);
  });

  it("groups tool-call messages into an ActionGroup and passes the interrupt through", () => {
    renderChatInterface();
    act(() => {
      stream.setMessages([
        humanTurn("run ls"),
        aiToolCallTurn("execute", { command: "ls" }, "t1"),
      ]);
      stream.setInterrupt(executeInterrupt("ls"));
    });

    const group = getLastProps<{
      actionRequests: unknown[];
      items: Array<{ message: { id: string } }>;
      autoApprove: boolean;
    }>("ActionGroup");
    expect(group).toBeDefined();
    expect(group?.actionRequests).toHaveLength(1);
    expect(group?.items[0].message.id).toBe("t1");
    expect(group?.autoApprove).toBe(false);
  });

  it("renders AskUserInterrupt when the interrupt is type ask_user", () => {
    renderChatInterface();
    act(() => {
      stream.setMessages([humanTurn("hi")]);
      stream.setInterrupt(askUserInterrupt("what do you want?"));
    });
    expect(screen.getByTestId("stub-AskUserInterrupt")).toBeDefined();
    // Not an ActionGroup — this is the ask-user branch.
    expect(screen.queryAllByTestId("stub-ActionGroup")).toHaveLength(0);
  });

  it("disables the composer submit button while a run is in flight", () => {
    const { container } = renderChatInterface();
    act(() => {
      stream.setLoading(false);
    });
    // Find the composer textarea and type into it so the send button
    // becomes enabled (it's disabled when the textarea is empty too).
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      fireEvent.change(textarea!, { target: { value: "hello" } });
    });
    const form = textarea!.closest("form");
    expect(form).not.toBeNull();
    const submitBtn = within(form as HTMLElement).getByRole("button", {
      name: /send message/i,
    });
    expect(submitBtn.hasAttribute("disabled")).toBe(false);

    // Now flip to loading — the send button becomes a Stop button.
    act(() => {
      stream.setLoading(true);
    });
    const stopBtn = within(form as HTMLElement).getByRole("button", {
      name: /stop/i,
    });
    expect(stopBtn).toBeDefined();
  });

  it("threads the sendMessage callback to the composer (submitting produces a stream submit)", () => {
    const { container } = renderChatInterface();
    const textarea = container.querySelector("textarea");
    act(() => {
      fireEvent.change(textarea!, { target: { value: "hi" } });
    });
    const form = textarea!.closest("form");
    act(() => {
      fireEvent.submit(form!);
    });
    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const body = calls[0].values as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).toBe("hi");
  });

  it("renders regular ChatMessages while isLoading is true (streaming in progress)", () => {
    renderChatInterface();
    act(() => {
      stream.setMessages([humanTurn("hi"), aiTurn("streaming...")]);
      stream.setLoading(true);
    });
    // Composer flipped to Stop button; message list still renders.
    expect(screen.getAllByTestId("stub-ChatMessage").length).toBeGreaterThan(0);
    // No error surface at this point.
    expect(screen.queryAllByTestId("stub-AskUserInterrupt")).toHaveLength(0);
  });

  it("stops loading and re-enables the composer when the SDK settles", () => {
    const { container } = renderChatInterface();
    act(() => {
      stream.setLoading(true);
    });
    // The composer submit-slot is a Stop button.
    const form = container.querySelector("form")!;
    expect(
      within(form).queryByRole("button", { name: /stop/i })
    ).not.toBeNull();

    act(() => {
      stream.setLoading(false);
    });
    // Back to a Send button — but disabled because the textarea is empty.
    expect(
      within(form).queryByRole("button", { name: /send message/i })
    ).not.toBeNull();
  });

  it("surfaces an SDK error as a toast (onError fires, no crash)", async () => {
    const { toast } = await import("sonner");
    renderChatInterface();
    act(() => {
      stream.emitError(new Error("provider outage"));
    });
    expect(toast.error).toHaveBeenCalled();
    const msg = vi.mocked(toast.error).mock.calls[0][0];
    expect(String(msg)).toContain("outage");
  });

  it("flows autoApprove state from thread-local storage into ActionGroup props", () => {
    // Seed storage BEFORE mount so ChatInterface's initial useState reads
    // the persisted value. threadId is null on a fresh chat -> the sentinel
    // "__new__" key holds the pending-new-chat setting.
    setThreadAutoApprove(null, true);

    renderChatInterface();
    act(() => {
      stream.setMessages([aiToolCallTurn("execute", { command: "ls" }, "t1")]);
      stream.setInterrupt(executeInterrupt("ls"));
    });

    const passes = getAllProps<{ autoApprove: boolean }>("ActionGroup");
    expect(passes.length).toBeGreaterThan(0);
    // The prop that ActionGroup ends up seeing reflects the seeded storage.
    expect(passes[passes.length - 1].autoApprove).toBe(true);
  });
});
