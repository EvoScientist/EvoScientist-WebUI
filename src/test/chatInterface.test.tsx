// @vitest-environment jsdom
//
// Integration tests for the full ChatInterface. Peripheral hooks are stubbed
// and child components (ChatMessage, ActionGroup, ...) render as prop-spy
// divs so we can assert prop flow at the composition layer without pulling
// the full render tree into scope.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  act,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { ComposerSnapshot } from "@/app/components/ChatInterface";
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
    useDeployment: () => mockDeployment,
  };
});

// The thread the (mocked) URL state opens on; null = a new chat.
let mockThreadId: string | null = null;

// What the (mocked) ClientProvider reports as the live deployment. Tests that
// exercise the approval policy point it at a URL; the default is "none".
let mockDeployment: { deploymentUrl: string | null; apiKey: string } = {
  deploymentUrl: null,
  apiKey: "",
};

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    // Only "threadId" is read through nuqs under ChatInterface/ChatProvider.
    useQueryState: () => react.useState<string | null>(mockThreadId),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
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
import { mockWorkspace, readyWorkspace } from "@/test/mockWorkspace";
import { renderChatInterface } from "@/test/renderChatInterface";
import {
  getAllProps,
  getLastProps,
  resetComponentSpy,
  stickToBottomStub,
} from "@/test/mocks/chatInterfaceStubs";
import {
  humanTurn,
  aiTurn,
  aiToolCallTurn,
  toolResultTurn,
} from "@/test/fixtures/messages";
import { FilePaneProvider } from "@/providers/FilePaneProvider";
import {
  useFilePane,
  type FilePaneContextValue,
} from "@/providers/filePaneContext";
import type { Message } from "@langchain/langgraph-sdk";
import {
  executeInterrupt,
  askUserInterrupt,
  multiActionInterrupt,
} from "@/test/fixtures/interrupts";
import { setThreadAutoApprove } from "@/lib/autoApprove";
import { resetApprovalPolicySupport } from "@/app/hooks/useApprovalPolicy";

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

  it("seeds the composer from draftSeed (message recovered from a vanished thread)", () => {
    renderChatInterface({
      draftSeed: { text: "draft that was never sent", files: [] },
    });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("draft that was never sent");
  });

  it("exposes the unsent composer state through onComposerSnapshotReady", () => {
    let getSnapshot: (() => ComposerSnapshot) | null = null;
    const { unmount } = renderChatInterface({
      onComposerSnapshotReady: (fn) => {
        getSnapshot = fn;
      },
    });
    expect(getSnapshot).not.toBeNull();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(textarea, { target: { value: "typed but unsent" } });
    });
    expect(getSnapshot!()).toEqual({ text: "typed but unsent", files: [] });
    unmount();
    expect(getSnapshot).toBeNull();
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

  it("hands a partially bound interrupt to the fallback instead of stranding a request", () => {
    // The main agent's own `execute` is still running (no result yet) next to
    // a `task`, and the sub-agent asks to approve two `execute` calls. Only one
    // can bind to a tool call box, so the whole batch must go to the fallback.
    renderChatInterface();
    act(() => {
      stream.setMessages([
        humanTurn("go"),
        {
          id: "t1",
          type: "ai",
          content: "",
          tool_calls: [
            { id: "t1c", name: "execute", args: { command: "sleep 60" } },
            { id: "t1d", name: "task", args: { subagent_type: "code-agent" } },
          ],
        } as unknown as Message,
      ]);
      stream.setInterrupt(multiActionInterrupt());
    });

    expect(screen.getByText("Approval requested by code-agent")).toBeTruthy();
    const group = getLastProps<{ actionRequests: unknown[] }>("ActionGroup");
    expect(group?.actionRequests).toHaveLength(0);
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

  it("keeps an ask_user form on the page, disabled, while the folder is read again", () => {
    renderChatInterface({
      workspace: {
        ...mockWorkspace(),
        refreshing: true,
        isReady: () => false,
      },
    });
    act(() => {
      stream.setMessages([humanTurn("hi")]);
      stream.setInterrupt(askUserInterrupt("what do you want?"));
    });

    // Unmounting it would drop what the user has typed.
    expect(screen.getByTestId("stub-AskUserInterrupt")).toBeDefined();
    expect(
      getLastProps<{ isLoading: boolean }>("AskUserInterrupt")?.isLoading
    ).toBe(true);
  });

  it("makes the chat read-only while a run-mode session holds the backend", () => {
    const { container } = renderChatInterface({
      workspace: mockWorkspace({
        ...readyWorkspace("/home/you/projA"),
        runDir: "/home/you/projA/runs/r1",
      }),
    });
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toMatch(/run folder/);

    act(() => {
      stream.setMessages([humanTurn("hi")]);
      stream.setInterrupt(askUserInterrupt("what do you want?"));
    });
    expect(screen.queryByTestId("stub-AskUserInterrupt")).toBeNull();
  });

  // "first" refused, with "second" queued behind it while it ran and
  // `draft` typed since.
  async function refuseWithQueued(draft = "") {
    const { container } = renderChatInterface({ workspace: mockWorkspace() });
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    const sent = stream.getSubmitCalls()[0]?.values as {
      messages: Message[];
    };
    act(() => {
      stream.setMessages([...sent.messages]);
      stream.setLoading(true);
    });
    fireEvent.change(textarea, { target: { value: "second" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: draft } });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
      stream.setLoading(false);
    });
    return { container, textarea };
  }
  const submitted = () =>
    stream
      .getSubmitCalls()
      .map(
        (call) =>
          (call.values as { messages: Message[] }).messages.at(-1)?.content
      );

  it("puts a refused message back in the composer with what was queued after it", async () => {
    const { textarea } = await refuseWithQueued("my draft");

    expect(textarea.value).toBe("first\n\nsecond\n\nmy draft");
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
  });

  it("sends nothing on its own after a refusal", async () => {
    await refuseWithQueued();

    // Runs from elsewhere come and go; what came back stays in the composer.
    act(() => {
      stream.setLoading(true);
    });
    act(() => {
      stream.setLoading(false);
    });

    expect(submitted()).toEqual(["first"]);
  });

  it("keeps a queued message while the folder is being read again", () => {
    let readyNow = true;
    const { container } = renderChatInterface({
      workspace: { ...mockWorkspace(), isReady: () => readyNow },
    });
    act(() => {
      stream.setMessages([humanTurn("hi")]);
      stream.setLoading(true);
    });
    const textarea = container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "follow-up" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    readyNow = false;
    act(() => {
      stream.setLoading(false);
    });

    expect(stream.getSubmitCalls()).toHaveLength(0);
    expect(
      screen.getAllByRole("button", { name: "Steer with this message next" })
    ).toHaveLength(1);
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

  it("surfaces a backend model-fallback notice as a single replaceable toast", async () => {
    const { toast } = await import("sonner");
    renderChatInterface();
    const onCustomEvent = stream.getOptions()?.onCustomEvent as (
      data: unknown,
      options: { namespace?: string[] }
    ) => void;
    act(() => {
      onCustomEvent(
        {
          evoscientist: {
            kind: "fallback_notice",
            text: "Primary model failed: APIError: overloaded",
            style: "yellow",
          },
        },
        { namespace: [] }
      );
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "Primary model failed: APIError: overloaded",
      { id: "model-fallback" }
    );
  });

  describe("model retries", () => {
    const start = (call: string) => ({
      type: "model_call",
      phase: "start",
      call,
    });
    const end = (call: string, status: string) => ({
      type: "model_call",
      phase: "end",
      call,
      status,
    });
    const retry = (extra: Record<string, unknown> = {}) => ({
      type: "model_retry",
      attempt: 2,
      wait_seconds: 1.1,
      reason: "Connection error.",
      budget_left_seconds: 58.9,
      cause: "exception",
      agent: "EvoScientist",
      ...extra,
    });
    // The id of the retry toast shown last.
    const lastRetryToastId = async () => {
      const { toast } = await import("sonner");
      const calls = vi.mocked(toast.warning).mock.calls;
      return (calls[calls.length - 1][1] as { id: string }).id;
    };
    // Ids of the messages the transcript currently shows, in order.
    const shownIds = () => {
      const shown = screen.queryAllByTestId("stub-ChatMessage").length;
      if (shown === 0) return [];
      return getAllProps<{ message: { id: string } }>("ChatMessage")
        .slice(-shown)
        .map((props) => props.message.id);
    };

    beforeEach(async () => {
      const { toast } = await import("sonner");
      vi.mocked(toast.warning).mockClear();
      vi.mocked(toast.dismiss).mockClear();
    });

    it("shows a retry as a toast and clears it once the retried call ends clean", async () => {
      const { toast } = await import("sonner");
      renderChatInterface();
      act(() => {
        stream.emitCustomEvent(start("c1"));
        stream.emitCustomEvent(end("c1", "failed"));
        stream.emitCustomEvent(retry());
      });
      expect(toast.warning).toHaveBeenCalledWith(
        "Model request failed (Connection error.); retrying in 1 s (attempt 2)",
        expect.objectContaining({
          id: expect.stringMatching(/^model-retry-\d+$/),
          duration: 5100,
          closeButton: true,
        })
      );
      act(() => {
        stream.emitCustomEvent(start("c2"));
      });
      expect(toast.dismiss).not.toHaveBeenCalled();
      act(() => {
        stream.emitCustomEvent(end("c2", "clean"));
      });
      expect(toast.dismiss).toHaveBeenCalledWith(await lastRetryToastId());
    });

    it("drops the failed call's half answer when the backend retries", () => {
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("say hello", "h1")]);
        stream.emitCustomEvent(start("c1"));
        stream.setMessages([
          humanTurn("say hello", "h1"),
          aiTurn("PARTIAL text", "partial"),
        ]);
      });
      expect(shownIds()).toEqual(["h1", "partial"]);
      act(() => {
        stream.emitCustomEvent(end("c1", "failed"));
      });
      // A failed call alone changes nothing: the run may still end in an error.
      expect(shownIds()).toEqual(["h1", "partial"]);
      act(() => {
        stream.emitCustomEvent(retry());
      });
      expect(shownIds()).toEqual(["h1"]);
      act(() => {
        stream.emitCustomEvent(start("c2"));
        stream.setMessages([
          ...stream.getSnapshot().messages,
          aiTurn("Hello!", "answer"),
        ]);
        stream.emitCustomEvent(end("c2", "clean"));
      });
      expect(shownIds()).toEqual(["h1", "answer"]);
    });

    it("drops a failed call's output when the next model starts without a retry (fallback chain)", () => {
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("q", "h1"), aiTurn("earlier", "a0")]);
        stream.emitCustomEvent(start("c1"));
        stream.setMessages([
          humanTurn("q", "h1"),
          aiTurn("earlier", "a0"),
          aiTurn("PARTIAL", "partial"),
        ]);
        stream.emitCustomEvent(end("c1", "error"));
        stream.emitCustomEvent(start("c2"));
      });
      expect(shownIds()).toEqual(["h1", "a0"]);
    });

    it("keeps a clean call's answer, and a call whose end mark never came, when the next call starts", () => {
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("q", "h1")]);
        stream.emitCustomEvent(start("c1"));
        stream.setMessages([humanTurn("q", "h1"), aiTurn("first", "a1")]);
        stream.emitCustomEvent(end("c1", "clean"));
        stream.emitCustomEvent(start("c2"));
        stream.setMessages([
          humanTurn("q", "h1"),
          aiTurn("first", "a1"),
          aiTurn("second", "a2"),
        ]);
        // No end mark for c2: losing a good answer is worse than keeping a bad one.
        stream.emitCustomEvent(start("c3"));
      });
      expect(shownIds()).toEqual(["h1", "a1", "a2"]);
    });

    it("ignores an end mark that belongs to another call", () => {
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("q", "h1")]);
        stream.emitCustomEvent(start("c1"));
        stream.setMessages([humanTurn("q", "h1"), aiTurn("answer", "a1")]);
        stream.emitCustomEvent(end("other", "failed"));
        stream.emitCustomEvent(start("c2"));
      });
      expect(shownIds()).toEqual(["h1", "a1"]);
    });

    it("never applies a sub-agent's call marks to the main agent's calls", () => {
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("q", "h1")]);
        stream.emitCustomEvent(start("c1"));
        stream.setMessages([
          humanTurn("q", "h1"),
          aiTurn("PARTIAL", "partial"),
        ]);
        stream.emitCustomEvent(end("c1", "failed"));
        stream.emitCustomEvent(start("s1"), ["tools:abc"]);
      });
      // The main agent's own retry (or next call) decides; a sub-agent's start does not.
      expect(shownIds()).toEqual(["h1", "partial"]);
      act(() => {
        stream.emitCustomEvent(retry());
      });
      expect(shownIds()).toEqual(["h1"]);
    });

    it("names a sub-agent's retry and leaves the transcript alone", async () => {
      const { toast } = await import("sonner");
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("q", "h1")]);
        // The main agent's call is still open (its end mark has not come).
        stream.emitCustomEvent(start("m0"));
        stream.setMessages([humanTurn("q", "h1"), aiTurn("main", "a1")]);
        stream.emitCustomEvent(start("s1"), ["tools:abc"]);
        stream.emitCustomEvent(end("s1", "failed"), ["tools:abc"]);
        stream.emitCustomEvent(retry({ agent: "code-agent" }), ["tools:abc"]);
      });
      expect(toast.warning).toHaveBeenCalledWith(
        "code-agent: Model request failed (Connection error.); retrying in 1 s (attempt 2)",
        expect.objectContaining({
          id: expect.stringMatching(/^model-retry-\d+$/),
        })
      );
      expect(shownIds()).toEqual(["h1", "a1"]);
      // The main agent's clean call is not the sub-agent's recovery.
      act(() => {
        stream.emitCustomEvent(start("m1"));
        stream.emitCustomEvent(end("m1", "clean"));
      });
      expect(toast.dismiss).not.toHaveBeenCalled();
      act(() => {
        stream.emitCustomEvent(start("s2"), ["tools:abc"]);
        stream.emitCustomEvent(end("s2", "clean"), ["tools:abc"]);
      });
      expect(toast.dismiss).toHaveBeenCalledWith(await lastRetryToastId());
    });

    it("clears a retry toast that is still up when the run ends, however it ends", async () => {
      const { toast } = await import("sonner");
      renderChatInterface();
      act(() => {
        stream.setLoading(true);
        stream.emitCustomEvent(retry());
      });
      expect(toast.dismiss).not.toHaveBeenCalled();
      act(() => {
        stream.setLoading(false);
      });
      expect(toast.dismiss).toHaveBeenCalledWith(await lastRetryToastId());
    });

    it("keeps retry state through a failed history fetch while the run streams", async () => {
      // The SDK reports a failed history fetch through the same onError.
      const { toast } = await import("sonner");
      renderChatInterface();
      act(() => {
        stream.setLoading(true);
        stream.setMessages([humanTurn("q", "h1")]);
        stream.emitCustomEvent(start("c1"));
        stream.setMessages([
          humanTurn("q", "h1"),
          aiTurn("PARTIAL", "partial"),
        ]);
        stream.emitError(new Error("Failed to fetch"));
        stream.emitCustomEvent(end("c1", "failed"));
        stream.emitCustomEvent(retry());
      });
      expect(shownIds()).toEqual(["h1"]);
      act(() => {
        stream.emitError(new Error("Failed to fetch"));
      });
      expect(toast.dismiss).not.toHaveBeenCalled();
    });

    it("clears a retry toast when the chat unmounts (thread switch, New Chat)", async () => {
      const { toast } = await import("sonner");
      const { unmount } = renderChatInterface();
      act(() => {
        stream.emitCustomEvent(retry());
      });
      unmount();
      expect(toast.dismiss).toHaveBeenCalledWith(await lastRetryToastId());
    });

    it("does not touch toasts on a run that never retried", async () => {
      const { toast } = await import("sonner");
      renderChatInterface();
      act(() => {
        stream.emitCustomEvent(start("c1"));
        stream.emitCustomEvent(end("c1", "clean"));
        stream.emitFinish();
      });
      expect(toast.warning).not.toHaveBeenCalled();
      expect(toast.dismiss).not.toHaveBeenCalled();
    });
  });

  it("resumes with the deployment's approval policy while auto-approve is off, without opening a card", async () => {
    resetApprovalPolicySupport();
    mockDeployment = { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" };
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ decisions: [{ type: "approve" }] }), {
          status: 200,
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderChatInterface();
      act(() => {
        stream.setMessages([
          humanTurn("status?"),
          aiToolCallTurn("execute", { command: "git status" }, "t1"),
        ]);
        stream.setInterrupt(executeInterrupt("git status"));
      });

      // Asked, not decided yet: the card stays quiet instead of flashing.
      expect(
        getLastProps<{ approvalAutoResolves: boolean }>("ActionGroup")
          ?.approvalAutoResolves
      ).toBe(true);

      await waitFor(() => expect(stream.getSubmitCalls()).toHaveLength(1));
      const opts = stream.getSubmitCalls()[0].options as {
        command: { resume: Record<string, { decisions: unknown[] }> };
      };
      expect(opts.command.resume["int-1"].decisions).toEqual([
        { type: "approve" },
      ]);
      // Other parts of the page fetch too (workspace listing), so look for the
      // policy call rather than assuming it came first.
      expect(
        fetchMock.mock.calls.some(
          ([url]) => String(url) === "http://127.0.0.1:6174/api/policy"
        )
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      mockDeployment = { deploymentUrl: null, apiKey: "" };
    }
  });

  it("hands the decision to the user when the deployment defers and auto-approve is off", async () => {
    resetApprovalPolicySupport();
    mockDeployment = { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ decisions: null }), { status: 200 })
      )
    );
    try {
      renderChatInterface();
      act(() => {
        stream.setMessages([
          humanTurn("run ls"),
          aiToolCallTurn("execute", { command: "ls" }, "t1"),
        ]);
        stream.setInterrupt(executeInterrupt("ls"));
      });
      await waitFor(() =>
        expect(
          getLastProps<{ approvalAutoResolves: boolean }>("ActionGroup")
            ?.approvalAutoResolves
        ).toBe(false)
      );
      expect(stream.getSubmitCalls()).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      mockDeployment = { deploymentUrl: null, apiKey: "" };
    }
  });

  it("asks the deployment the provider is connected to, not a stored one", async () => {
    // Reconnecting (HealthIndicator) swaps the deployment without remounting
    // the chat, so a URL read once from storage would go on asking the old one.
    resetApprovalPolicySupport();
    localStorage.setItem(
      "evoscientist-config",
      JSON.stringify({
        deploymentUrl: "http://stale.invalid:6174",
        assistantId: "EvoScientist",
      })
    );
    mockDeployment = { deploymentUrl: "http://127.0.0.1:7001", apiKey: "" };
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ decisions: null }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderChatInterface();
      act(() => {
        stream.setMessages([
          humanTurn("run ls"),
          aiToolCallTurn("execute", { command: "ls" }, "t1"),
        ]);
        stream.setInterrupt(executeInterrupt("ls"));
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) =>
            String(url).endsWith("/api/policy")
          )
        ).toBe(true)
      );
      const asked = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.endsWith("/api/policy"));
      expect(asked).toEqual(["http://127.0.0.1:7001/api/policy"]);
    } finally {
      vi.unstubAllGlobals();
      localStorage.removeItem("evoscientist-config");
      mockDeployment = { deploymentUrl: null, apiKey: "" };
    }
  });

  it("keeps the fallback card's buttons disabled until the deployment has answered", async () => {
    // A sub-agent's request has no tool call to bind to, so its card is always
    // on screen. Deciding by hand while the deployment is still being asked
    // would race the decision it is about to return.
    resetApprovalPolicySupport();
    mockDeployment = { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" };
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("/api/policy")
          ? new Promise<Response>((resolve) => (release = resolve))
          : Promise.resolve(new Response("{}", { status: 200 }))
      )
    );
    try {
      renderChatInterface();
      act(() => {
        stream.setMessages([
          humanTurn("go"),
          aiToolCallTurn("task", { subagent_type: "code-agent" }, "t1"),
        ]);
        stream.setInterrupt(executeInterrupt("ls"));
      });
      expect(screen.getByText("Approval requested by code-agent")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

      await act(async () => {
        release(
          new Response(JSON.stringify({ decisions: null }), { status: 200 })
        );
        await Promise.resolve();
      });
      await waitFor(() => {
        const approve = screen.getByRole("button", { name: "Approve" });
        expect((approve as HTMLButtonElement).disabled).toBe(false);
      });
    } finally {
      vi.unstubAllGlobals();
      mockDeployment = { deploymentUrl: null, apiKey: "" };
    }
  });

  it.each([
    ["interrupted", "stopped"],
    ["busy", "pending"],
  ])(
    "marks an unanswered tool call on a %s thread as %s",
    async (threadStatus, expected) => {
      // A run that was stopped leaves a tool call with no result. It may only
      // stop spinning once the server says nothing is working on the thread.
      mockThreadId = "t-1";
      const client = getActiveMockClient();
      const messages = [
        humanTurn("run it"),
        aiToolCallTurn("execute", { command: "sleep 600" }, "t1"),
      ];
      client.setThreadState("t-1", {
        next: ["tools"],
        tasks: [],
        values: { messages },
      });
      client.setThreadRecord("t-1", { status: threadStatus });
      try {
        renderChatInterface();
        act(() => {
          stream.setMessages(messages);
        });
        const statusOf = () =>
          getLastProps<{
            items: Array<{ toolCalls: Array<{ status: string }> }>;
          }>("ActionGroup")?.items[0].toolCalls[0].status;
        await waitFor(() =>
          expect(client.threads.get.mock.calls.length).toBeGreaterThan(0)
        );
        await waitFor(() => expect(statusOf()).toBe(expected));
      } finally {
        mockThreadId = null;
      }
    }
  );

  it("keeps an earlier turn's unanswered tool call stopped while a new run streams", () => {
    // Once the user has moved on to another turn nothing can answer the old
    // call any more, whatever the current run is doing — it must not start
    // spinning again just because something is loading.
    renderChatInterface();
    act(() => {
      stream.setMessages([
        humanTurn("run it", "h1"),
        aiToolCallTurn("execute", { command: "sleep 600" }, "t1"),
        humanTurn("never mind, do this instead", "h2"),
        aiToolCallTurn("execute", { command: "ls" }, "t2"),
      ]);
      stream.setLoading(true);
    });
    const groups = getAllProps<{
      items: Array<{
        message: { id: string };
        toolCalls: Array<{ status: string }>;
      }>;
    }>("ActionGroup");
    const statusOf = (messageId: string) =>
      [...groups]
        .reverse()
        .flatMap((g) => g.items)
        .find((item) => item.message.id === messageId)?.toolCalls[0].status;
    expect(statusOf("t1")).toBe("stopped");
    expect(statusOf("t2")).toBe("pending");
  });

  it("gives a new turn's approval to its own tool call, not to a stopped one of the same name", () => {
    // Statuses are dealt out by tool name, oldest message first. A dead
    // `execute` left behind by Stop must not claim the next turn's approval.
    renderChatInterface();
    act(() => {
      stream.setMessages([
        humanTurn("run it", "h1"),
        aiToolCallTurn("execute", { command: "sleep 600" }, "t1"),
        humanTurn("list files instead", "h2"),
        aiToolCallTurn("execute", { command: "ls" }, "t2"),
      ]);
      stream.setInterrupt(executeInterrupt("ls"));
    });
    const groups = getAllProps<{
      items: Array<{
        message: { id: string };
        toolCalls: Array<{ status: string }>;
      }>;
    }>("ActionGroup");
    const statusOf = (messageId: string) =>
      [...groups]
        .reverse()
        .flatMap((g) => g.items)
        .find((item) => item.message.id === messageId)?.toolCalls[0].status;
    expect(statusOf("t1")).toBe("stopped");
    expect(statusOf("t2")).toBe("interrupted");
    // Bound inline, so it is not mislabelled as a sub-agent's request.
    expect(screen.queryByText(/^Approval requested by/)).toBeNull();
  });

  it("keeps a pinned skill message inside its turn, between the user message and the reply", () => {
    // The backend appends the pinned SKILL.md as a human message right after
    // the user's. It must neither start a turn of its own for the earlier
    // calls nor reorder the transcript.
    const pinned = {
      id: "p1",
      type: "human",
      content: '<skill name="paper-review">body</skill>',
      additional_kwargs: {
        lc_source: "pinned_skill",
        skill: { name: "paper-review" },
      },
    } as unknown as Message;
    renderChatInterface();
    act(() => {
      stream.setMessages([
        humanTurn("run it", "h1"),
        aiToolCallTurn("execute", { command: "sleep 600" }, "t1"),
        humanTurn("/paper-review check it", "h2"),
        pinned,
        aiToolCallTurn("execute", { command: "ls" }, "t2"),
      ]);
      stream.setInterrupt(executeInterrupt("ls"));
    });
    const shown = screen.getAllByTestId("stub-ChatMessage").length;
    const order = getAllProps<{ message: { id: string } }>("ChatMessage")
      .slice(-shown)
      .map((props) => props.message.id);
    expect(order).toEqual(["h1", "h2", "p1"]);
    const groups = getAllProps<{
      items: Array<{
        message: { id: string };
        toolCalls: Array<{ status: string }>;
      }>;
    }>("ActionGroup");
    const statusOf = (messageId: string) =>
      [...groups]
        .reverse()
        .flatMap((g) => g.items)
        .find((item) => item.message.id === messageId)?.toolCalls[0].status;
    expect(statusOf("t1")).toBe("stopped");
    expect(statusOf("t2")).toBe("interrupted");
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

  it("dedupes duplicate tool_call ids within one AI message (no duplicate keys)", () => {
    // Regression: LangChain's streaming merge (made likelier by aborting a run
    // mid-tool-call) can leave the same tool_call twice in one AI message. The
    // render keys off tool_call.id, so a repeat threw React's "two children with
    // the same key" and duplicated the box. processedMessages must collapse it.
    renderChatInterface();
    act(() => {
      stream.setMessages([
        {
          id: "a1",
          type: "ai",
          content: "",
          tool_calls: [
            { id: "dup1", name: "execute", args: { command: "ls" } },
            { id: "dup1", name: "execute", args: { command: "ls" } },
          ],
        } as unknown as Message,
      ]);
    });
    const groups = getAllProps<{
      items: Array<{ toolCalls: Array<{ id: string }> }>;
    }>("ActionGroup");
    expect(groups.length).toBeGreaterThan(0);
    const ids = groups[groups.length - 1].items.flatMap((item) =>
      item.toolCalls.map((tc) => tc.id)
    );
    expect(ids).toEqual(["dup1"]);
  });

  it("keeps a dropped duplicate's args and stable fallback keys for id-less calls", () => {
    // The streaming merge can also split a call's data across the duplicate
    // copies (kept copy args-less, repeat carrying the real args) — the kept
    // copy must adopt them, or an args-less `task` survivor vanishes from the
    // render. An id-less call after the collapsed duplicate keeps its
    // pre-filter fallback key, so the collapse doesn't remount its box.
    renderChatInterface();
    act(() => {
      stream.setMessages([
        {
          id: "a1",
          type: "ai",
          content: "",
          tool_calls: [
            { id: "dup1", name: "execute", args: {} },
            { id: "dup1", name: "execute", args: { command: "ls" } },
            { name: "execute", args: { command: "pwd" } },
          ],
        } as unknown as Message,
      ]);
    });
    const groups = getAllProps<{
      items: Array<{
        toolCalls: Array<{ id: string; args: Record<string, unknown> }>;
      }>;
    }>("ActionGroup");
    expect(groups.length).toBeGreaterThan(0);
    const calls = groups[groups.length - 1].items.flatMap(
      (item) => item.toolCalls
    );
    expect(calls.map((tc) => tc.id)).toEqual(["dup1", "a1-tool-2-execute"]);
    expect(calls[0].args).toEqual({ command: "ls" });
    expect(calls[1].args).toEqual({ command: "pwd" });
  });

  it("donates the duplicate's name to an empty-name kept copy", () => {
    // Only the additional_kwargs path can normalize to an empty name (the
    // top-level tool_calls path filters those out). An undonated name renders
    // as "unknown" and breaks pending-action matching for the real call.
    renderChatInterface();
    act(() => {
      stream.setMessages([
        {
          id: "a2",
          type: "ai",
          content: "",
          additional_kwargs: {
            tool_calls: [
              { id: "dup2", function: { name: "", arguments: "{}" } },
              {
                id: "dup2",
                function: { name: "execute", arguments: '{"command":"ls"}' },
              },
            ],
          },
        } as unknown as Message,
      ]);
    });
    const groups = getAllProps<{
      items: Array<{
        toolCalls: Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
        }>;
      }>;
    }>("ActionGroup");
    expect(groups.length).toBeGreaterThan(0);
    const calls = groups[groups.length - 1].items.flatMap(
      (item) => item.toolCalls
    );
    expect(calls.map((tc) => [tc.id, tc.name])).toEqual([["dup2", "execute"]]);
    expect(calls[0].args).toEqual({ command: "ls" });
  });

  describe("file pane bridge", () => {
    let pane: FilePaneContextValue | null = null;
    function Probe() {
      pane = useFilePane();
      return null;
    }
    const FilePaneWrapper = ({ children }: { children: React.ReactNode }) => (
      <FilePaneProvider>
        <Probe />
        {children}
      </FilePaneProvider>
    );

    beforeEach(() => {
      pane = null;
    });

    it("hands the conversation's agent files to the file pane", async () => {
      stream.setValues({ files: { "notes.md": "hi" } });
      renderChatInterface({ wrapper: FilePaneWrapper });
      await waitFor(() =>
        expect(pane?.chat?.files).toEqual({ "notes.md": "hi" })
      );
    });

    it("signals a finished tool call, not the history it loaded with", async () => {
      const history = [
        humanTurn(),
        aiToolCallTurn("write_file", { file_path: "a.md" }, "t1"),
        toolResultTurn("ok", "t1r", "t1c"),
      ];
      stream.setMessages(history);
      renderChatInterface({ wrapper: FilePaneWrapper });
      await waitFor(() => expect(pane).not.toBeNull());
      expect(pane!.refreshTick).toBe(0);

      // A new message without a tool result: the loaded history still
      // doesn't count.
      const withReply = [...history, aiTurn("working on it", "a2")];
      await act(async () => {
        stream.setMessages(withReply);
      });
      expect(pane!.refreshTick).toBe(0);

      act(() =>
        stream.setMessages([
          ...withReply,
          aiToolCallTurn("execute", { command: "ls" }, "t2"),
          toolResultTurn("ok", "t2r", "t2c"),
        ])
      );
      await waitFor(() => expect(pane!.refreshTick).toBe(1));
    });

    it("signals the end of a turn", async () => {
      stream.setLoading(true);
      renderChatInterface({ wrapper: FilePaneWrapper });
      await waitFor(() => expect(pane).not.toBeNull());
      act(() => stream.setLoading(false));
      await waitFor(() => expect(pane!.refreshTick).toBe(1));
    });
  });

  // The composer's `/` menu: installed skills to pin (useSlashMenu has the
  // detail; this is the wiring into the real composer).
  describe("ChatInterface `/` menu", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url).includes("/api/skills/pinnable")
            ? new Response(
                JSON.stringify({
                  skills: [
                    {
                      name: "paper-writing",
                      description: "Write a paper",
                      source: "global",
                    },
                  ],
                })
              )
            : new Response("{}")
        )
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const typeInComposer = (container: HTMLElement, text: string) => {
      const textarea = container.querySelector("textarea")!;
      act(() => textarea.focus());
      fireEvent.change(textarea, { target: { value: text } });
      return textarea;
    };

    it("inserts a skill with Enter instead of sending", async () => {
      const { container } = renderChatInterface();
      const textarea = typeInComposer(container, "/pa");
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(textarea.value).toBe("/paper-writing ");
      expect(stream.getSubmitCalls()).toHaveLength(0);
    });

    it("offers only the global skills when the backend's folder is elsewhere", async () => {
      const { container } = renderChatInterface({
        workspace: mockWorkspace({
          ...readyWorkspace("/srv/projB"),
          local: { dir: "/home/you/projA", sameFolder: false },
        }),
      });
      typeInComposer(container, "/pa");
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
      expect(fetch).toHaveBeenCalledWith(
        "/api/skills/pinnable?workspace=0",
        expect.anything()
      );
    });

    it("stays shut while the agent waits on an answer", async () => {
      const { container } = renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("hi")]);
        stream.setInterrupt(askUserInterrupt("what next?"));
      });
      typeInComposer(container, "/pa");
      await act(async () => {});
      expect(screen.queryByRole("listbox")).toBeNull();
      // And opens once the answer is in.
      act(() => stream.setInterrupt(undefined));
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
    });

    it("leaves /model to the model picker", async () => {
      // A description that mentions models matches "model" too.
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                skills: [
                  {
                    name: "evo-memory",
                    description: "Remember model training runs",
                    source: "global",
                  },
                ],
              })
            )
        )
      );
      const { container } = renderChatInterface();
      const textarea = typeInComposer(container, "/model");
      await act(async () => {});
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(
        screen.getByRole("dialog", { name: "Pick a model for this chat" })
      ).toBeTruthy();
      expect(stream.getSubmitCalls()).toHaveLength(0);
    });

    it("opens the Skills marketplace when nothing is installed", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ skills: [] })))
      );
      const onNavigate = vi.fn();
      const { container } = renderChatInterface({ onNavigate });
      const textarea = typeInComposer(container, "/");
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(onNavigate).toHaveBeenCalledWith({ view: "skills" });
    });

    it("sends with Enter once the menu is closed", async () => {
      const { container } = renderChatInterface();
      const textarea = typeInComposer(container, "/pa");
      await waitFor(() =>
        expect(screen.getAllByRole("option")).toHaveLength(1)
      );
      fireEvent.keyDown(textarea, { key: "Escape" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      const calls = stream.getSubmitCalls();
      expect(calls).toHaveLength(1);
      const body = calls[0].values as { messages: Array<{ content: string }> };
      expect(body.messages[0].content).toBe("/pa");
    });
  });

  describe("jump to the latest message", () => {
    const scrollToBottom = vi.fn();

    beforeEach(() => {
      scrollToBottom.mockClear();
      stickToBottomStub.scrollToBottom = scrollToBottom;
    });

    afterEach(() => {
      stickToBottomStub.isAtBottom = true;
      stickToBottomStub.scrollToBottom = () => {};
    });

    const jumpButton = () =>
      screen.queryByRole("button", { name: "Jump to latest message" });

    it("appears when the user has scrolled up and scrolls down on click", () => {
      stickToBottomStub.isAtBottom = false;
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("hi"), aiTurn("hello")]);
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Jump to latest message" })
      );

      expect(scrollToBottom).toHaveBeenCalledTimes(1);
    });

    // At the bottom the button unmounts, which would drop a keyboard user's
    // focus on <body>. A keyboard press fires a click with `detail` 0.
    it("hands focus to the composer when pressed from the keyboard", () => {
      stickToBottomStub.isAtBottom = false;
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("hi"), aiTurn("hello")]);
      });
      const button = screen.getByRole("button", {
        name: "Jump to latest message",
      });
      button.focus();

      fireEvent.click(button, { detail: 0 });

      expect(document.activeElement).toBe(screen.getByRole("textbox"));
    });

    // Browsers focus a button on mouse press; the button then unmounts and the
    // draft in the composer loses its caret. The press must not take focus.
    it("does not take focus on a mouse press", () => {
      stickToBottomStub.isAtBottom = false;
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("hi"), aiTurn("hello")]);
      });

      const notCancelled = fireEvent.mouseDown(
        screen.getByRole("button", { name: "Jump to latest message" })
      );

      expect(notCancelled).toBe(false);
    });

    // A tap must not focus the composer: on a phone that opens the keyboard.
    it("leaves focus alone on a pointer click", () => {
      stickToBottomStub.isAtBottom = false;
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("hi"), aiTurn("hello")]);
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Jump to latest message" }),
        { detail: 1 }
      );

      expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
    });

    it("stays hidden at the bottom", () => {
      renderChatInterface();
      act(() => {
        stream.setMessages([humanTurn("hi"), aiTurn("hello")]);
      });

      expect(jumpButton()).toBeNull();
    });

    // The empty state's dashboard can be taller than the window; there is no
    // message to jump to while it is scrolled.
    it("stays hidden in an empty conversation", () => {
      stickToBottomStub.isAtBottom = false;
      renderChatInterface();

      expect(jumpButton()).toBeNull();
    });
  });
});
