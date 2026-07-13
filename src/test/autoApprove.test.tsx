// @vitest-environment jsdom
//
// Scenario: auto-approve is on. Every interrupt with a non-empty
// `action_requests` list is resumed automatically with approve decisions
// without user interaction. The critical property is the identity guard:
// a re-render with the SAME interrupt object still visible must NOT re-fire
// a submit — that guard is what stopped the tight loop the user chased
// earlier this session.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { toast } from "sonner";
import type { ReactNode } from "react";
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

import { ChatProvider, useChatContext } from "@/providers/ChatProvider";
import { useAutoApproveInterrupt } from "@/app/hooks/useAutoApproveInterrupt";
import { fixtureAssistant } from "@/test/fixtures/assistants";

// Interrupts as they arrive from the HumanInTheLoopMiddleware — the reference
// held on each object matters for the identity guard, so tests either reuse
// or construct fresh instances deliberately.
const makeExecuteInterrupt = (command: string) => ({
  value: {
    action_requests: [{ name: "execute", args: { command } }],
  },
});

// Mount ChatProvider and wire the auto-approve hook in the same render.
// `autoApprove` and `resetKey` are props on the test-side wrapper so
// `rerender` can drive transitions without unmounting.
function renderChatWithAutoApprove(
  initial: { autoApprove: boolean; resetKey?: string | null } = {
    autoApprove: true,
  }
) {
  return renderHook(
    (props: { autoApprove: boolean; resetKey?: string | null }) => {
      const chat = useChatContext();
      useAutoApproveInterrupt({
        autoApprove: props.autoApprove,
        interrupt: chat.interrupt,
        resumeInterrupt: chat.resumeInterrupt,
        resetKey: props.resetKey,
      });
      return chat;
    },
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) => (
        <ChatProvider activeAssistant={fixtureAssistant}>
          {children}
        </ChatProvider>
      ),
    }
  );
}

describe("auto-approve scenario", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("auto-fires a single approve submit when an actionable interrupt arrives", () => {
    renderChatWithAutoApprove({ autoApprove: true });

    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toBeNull();
    const opts = calls[0].options as {
      command: { resume: { decisions: Array<{ type: string }> } };
    };
    expect(opts.command.resume.decisions).toEqual([{ type: "approve" }]);
  });

  it("emits one approve decision per action_request in the interrupt", () => {
    renderChatWithAutoApprove({ autoApprove: true });

    act(() => {
      stream.setInterrupt({
        value: {
          action_requests: [
            { name: "execute", args: { command: "ls" } },
            { name: "read_file", args: { path: "/x" } },
            { name: "execute", args: { command: "pwd" } },
          ],
        },
      });
    });

    const opts = stream.getSubmitCalls()[0].options as {
      command: { resume: { decisions: Array<{ type: string }> } };
    };
    expect(opts.command.resume.decisions).toEqual([
      { type: "approve" },
      { type: "approve" },
      { type: "approve" },
    ]);
  });

  it("does NOT re-fire when the same interrupt object is still present after a re-render (identity guard)", () => {
    const { rerender } = renderChatWithAutoApprove({ autoApprove: true });

    // Same object reference reused so the ref stays === after re-render.
    const interruptA = makeExecuteInterrupt("ls");
    act(() => {
      stream.setInterrupt(interruptA);
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);

    // Force a re-render without changing the interrupt on the store.
    // Without the identity guard, this is where the tight loop shows up
    // (the effect fires again on every render).
    act(() => {
      rerender({ autoApprove: true });
      rerender({ autoApprove: true });
      rerender({ autoApprove: true });
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
  });

  it("re-fires when a NEW interrupt object arrives (different reference)", () => {
    renderChatWithAutoApprove({ autoApprove: true });

    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);

    // Fresh reference — the SDK created a new interrupt for the next tool
    // call, even if the content looks similar. Auto-approve should fire again.
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("pwd"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(2);
    const secondOpts = stream.getSubmitCalls()[1].options as {
      command: { resume: { decisions: Array<{ type: string }> } };
    };
    expect(secondOpts.command.resume.decisions).toEqual([{ type: "approve" }]);
  });

  it("fires exactly N submits for N fresh interrupts each in its own render tick", () => {
    // The pre-fix bug was a runaway loop: the effect re-firing per render
    // regardless of what state actually changed. When N genuinely distinct
    // interrupts arrive across N render ticks, we should see exactly N
    // submits — not N*K for some hidden re-render multiplier.
    renderChatWithAutoApprove({ autoApprove: true });
    const N = 10;
    for (let i = 0; i < N; i++) {
      act(() => {
        stream.setInterrupt(makeExecuteInterrupt(`cmd${i}`));
      });
    }
    expect(stream.getSubmitCalls()).toHaveLength(N);
  });

  it("does NOT fire when autoApprove is off, even for an actionable interrupt", () => {
    renderChatWithAutoApprove({ autoApprove: false });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("does NOT fire for an interrupt without action_requests (e.g. ask_user)", () => {
    renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt({
        value: {
          type: "ask_user",
          questions: [{ question: "what next?" }],
        },
      });
    });
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("does NOT fire for an interrupt with an empty action_requests list", () => {
    renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt({ value: { action_requests: [] } });
    });
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("re-fires on the same interrupt after autoApprove is toggled off then back on", () => {
    // Real flow: user turns auto-approve off, an interrupt stays pending,
    // user changes their mind and turns it back on. The pending interrupt
    // should be auto-approved on the next tick, not silently ignored.
    const interruptA = makeExecuteInterrupt("ls");
    const { rerender } = renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt(interruptA);
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);

    act(() => {
      rerender({ autoApprove: false });
    });
    // Off state: submit count stays the same even if the interrupt is here.
    expect(stream.getSubmitCalls()).toHaveLength(1);

    act(() => {
      rerender({ autoApprove: true });
    });
    // The internal identity guard was reset on the autoApprove flip, so the
    // still-pending interrupt fires again.
    expect(stream.getSubmitCalls()).toHaveLength(2);
  });

  it("resets the identity guard when resetKey changes (thread switch)", () => {
    const interruptA = makeExecuteInterrupt("ls");
    const { rerender } = renderChatWithAutoApprove({
      autoApprove: true,
      resetKey: "thread-1",
    });
    act(() => {
      stream.setInterrupt(interruptA);
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);

    // Switching thread: same interrupt object reused (contrived — the store
    // would normally be reset too), we assert the ref cleared.
    act(() => {
      rerender({ autoApprove: true, resetKey: "thread-2" });
    });
    expect(stream.getSubmitCalls()).toHaveLength(2);
  });
});
