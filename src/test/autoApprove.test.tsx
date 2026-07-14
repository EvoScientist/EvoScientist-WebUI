// @vitest-environment jsdom
//
// Scenario: auto-approve is on. Every interrupt with a non-empty
// `action_requests` list is resumed automatically with approve decisions.
// Two critical guarantees:
//   1. A given interrupt VALUE (keyed by `interruptValueKey`) is approved at
//      most once — a re-observed same-content interrupt, even with a fresh
//      object reference, does not re-fire. That's the fix for the tight loop
//      the user chased earlier this session.
//   2. Auto-approve waits for `isLoading` to transition to false before
//      firing. The SDK's `start()` early-returns while a run is in flight,
//      silently swallowing our resume — so we must observe the transition.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
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

// Fresh interrupt object each call. Value is what feeds `interruptValueKey`,
// so tests can assert on both same-value-different-ref and different-value.
const makeExecuteInterrupt = (command: string) => ({
  value: {
    action_requests: [{ name: "execute", args: { command } }],
  },
});

interface HarnessProps {
  autoApprove: boolean;
  isLoading?: boolean;
  resetKey?: string | null;
}

// Mount ChatProvider and wire the auto-approve hook in the same render.
// autoApprove / isLoading / resetKey are props on the test-side wrapper so
// `rerender` can drive transitions without unmounting.
function renderChatWithAutoApprove(
  initial: HarnessProps = { autoApprove: true }
) {
  return renderHook(
    (props: HarnessProps) => {
      const chat = useChatContext();
      useAutoApproveInterrupt({
        autoApprove: props.autoApprove,
        interrupt: chat.interrupt,
        resumeInterrupt: chat.resumeInterrupt,
        isLoading: props.isLoading ?? false,
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

  it("suppresses a same-content interrupt even from a fresh object reference (keyed guard)", () => {
    // The pre-fix bug: fresh object references per SSE tick made the identity
    // guard useless, so the same logical interrupt approved dozens of times.
    // The Set-based guard keys off the JSON of `value` so content dedupes.
    renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
    act(() => {
      // Fresh reference, identical content -> same key.
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
  });

  it("does NOT re-fire when a re-render occurs with the same interrupt still present", () => {
    const { rerender } = renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
    // Re-renders with no state change: guard still holds.
    act(() => {
      rerender({ autoApprove: true });
      rerender({ autoApprove: true });
      rerender({ autoApprove: true });
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
  });

  it("re-fires when a new interrupt with a different value arrives", () => {
    renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("pwd"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(2);
  });

  it("does NOT fire while isLoading is true (SDK-swallowed resume race)", () => {
    // The SDK's `start()` early-returns when isLoading is already true. Firing
    // in that window silently drops the resume. The hook waits for the flip.
    renderChatWithAutoApprove({ autoApprove: true, isLoading: true });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("fires once isLoading transitions to false with a still-pending interrupt", () => {
    const { rerender } = renderChatWithAutoApprove({
      autoApprove: true,
      isLoading: true,
    });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(0);
    act(() => {
      rerender({ autoApprove: true, isLoading: false });
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
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
    const { rerender } = renderChatWithAutoApprove({ autoApprove: true });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
    act(() => {
      rerender({ autoApprove: false });
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
    act(() => {
      rerender({ autoApprove: true });
    });
    // The Set was reset on autoApprove change; still-pending interrupt fires again.
    expect(stream.getSubmitCalls()).toHaveLength(2);
  });

  it("fires exactly once under StrictMode mount replay with a pre-existing interrupt", async () => {
    stream.setInterrupt(makeExecuteInterrupt("ls"));

    function StrictHarness() {
      const chat = useChatContext();
      useAutoApproveInterrupt({
        autoApprove: true,
        interrupt: chat.interrupt,
        resumeInterrupt: chat.resumeInterrupt,
        isLoading: false,
        resetKey: "thread-1",
      });
      return null;
    }

    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    root.render(
      <StrictMode>
        <ChatProvider activeAssistant={fixtureAssistant}>
          <StrictHarness />
        </ChatProvider>
      </StrictMode>
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stream.getSubmitCalls()).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
    el.remove();
  });

  it("resets the Set when resetKey changes (thread switch)", () => {
    const { rerender } = renderChatWithAutoApprove({
      autoApprove: true,
      resetKey: "thread-1",
    });
    act(() => {
      stream.setInterrupt(makeExecuteInterrupt("ls"));
    });
    expect(stream.getSubmitCalls()).toHaveLength(1);
    act(() => {
      rerender({ autoApprove: true, resetKey: "thread-2" });
    });
    // Same interrupt value but Set was cleared on the new thread -> fires again.
    expect(stream.getSubmitCalls()).toHaveLength(2);
  });
});
