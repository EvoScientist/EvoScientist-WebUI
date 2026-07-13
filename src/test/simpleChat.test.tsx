// @vitest-environment jsdom
//
// Scenario: a fresh chat where the user sends one message, the assistant
// responds, and no interrupts fire. The submit body carries the composer's
// text plus the config/streamMode options useChat pins for every run, and
// once the SDK settles the assistant turn back, both messages surface as the
// visible transcript with no error side-effects.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { toast } from "sonner";
import type { Message } from "@langchain/langgraph-sdk";
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { renderChat } from "@/test/renderChat";
import { fixtureAssistantWithConfig as fixtureAssistant } from "@/test/fixtures/assistants";

describe("simple chat scenario", () => {
  let stream: MockStreamStore;
  let historyRevalidate: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
    historyRevalidate = vi.fn();
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("submits the composed message with the pinned run options", () => {
    const { result } = renderChat({
      activeAssistant: fixtureAssistant,
      onHistoryRevalidate: () => historyRevalidate(),
    });

    act(() => {
      result.current.sendMessage("hi");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);

    // Body carries the composed text as a single human turn with a UUID id.
    const body = calls[0].values as { messages: Message[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].type).toBe("human");
    expect(body.messages[0].content).toBe("hi");
    expect(typeof body.messages[0].id).toBe("string");
    expect((body.messages[0].id as string).length).toBeGreaterThan(0);

    // Options carry the pinned run config: subgraph streaming, updates-only
    // stream mode, resumable, continue-on-disconnect. These are the exact
    // knobs that got the SDK 1.6.5+ regression in the first place.
    const opts = calls[0].options as {
      streamSubgraphs: boolean;
      streamMode: string[];
      streamResumable: boolean;
      onDisconnect: string;
      config: {
        configurable: Record<string, unknown>;
        recursion_limit: number;
      };
    };
    expect(opts.streamSubgraphs).toBe(true);
    expect(opts.streamMode).toEqual(["updates"]);
    expect(opts.streamResumable).toBe(true);
    expect(opts.onDisconnect).toBe("continue");
    expect(opts.config.recursion_limit).toBe(100);
    // Assistant-level config is merged in.
    expect(opts.config.configurable.some_seed).toBe("abc");
  });

  it("immediately kicks off a thread-list revalidate on send", () => {
    const { result } = renderChat({
      activeAssistant: fixtureAssistant,
      onHistoryRevalidate: () => historyRevalidate(),
    });
    act(() => {
      result.current.sendMessage("hi");
    });
    expect(historyRevalidate).toHaveBeenCalledTimes(1);
  });

  it("reflects isLoading transitions from the SDK", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    expect(result.current.isLoading).toBe(false);
    act(() => {
      stream.setLoading(true);
    });
    expect(result.current.isLoading).toBe(true);
    act(() => {
      stream.setLoading(false);
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("surfaces both user and assistant messages after the run settles", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    // Send.
    act(() => {
      result.current.sendMessage("hi");
    });

    // Stream lifecycle: SDK acks the run, streams the assistant reply,
    // then settles. Our mock doesn't merge optimistic values automatically —
    // we push the settled snapshot directly, matching what the real SDK
    // ends up with once the run completes.
    const settled: Message[] = [
      { id: "u1", type: "human", content: "hi" } as Message,
      { id: "a1", type: "ai", content: "hello, human" } as Message,
    ];
    act(() => {
      stream.setLoading(true);
      stream.setMessages(settled);
      stream.setLoading(false);
    });

    expect(result.current.messages).toHaveLength(2);
    expect((result.current.messages[0] as { content: unknown }).content).toBe(
      "hi"
    );
    expect((result.current.messages[1] as { content: unknown }).content).toBe(
      "hello, human"
    );
    expect(result.current.interrupt).toBeUndefined();
  });

  it("does not surface an error toast in the happy path", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      result.current.sendMessage("hi");
      stream.setLoading(true);
      stream.setMessages([
        { id: "u1", type: "human", content: "hi" } as Message,
        { id: "a1", type: "ai", content: "reply" } as Message,
      ]);
      stream.setLoading(false);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("each sendMessage produces a distinct submit call with a unique id", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      result.current.sendMessage("first");
    });
    act(() => {
      result.current.sendMessage("second");
    });
    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(2);
    const first = (calls[0].values as { messages: Message[] }).messages[0];
    const second = (calls[1].values as { messages: Message[] }).messages[0];
    expect(first.content).toBe("first");
    expect(second.content).toBe("second");
    expect(first.id).not.toBe(second.id);
  });

  it("propagates SDK errors as a toast (onError -> sonner)", () => {
    renderChat({
      activeAssistant: fixtureAssistant,
      onHistoryRevalidate: () => historyRevalidate(),
    });
    act(() => {
      stream.emitError(new Error("provider quota exceeded"));
    });
    // The onError callback in useChat calls toast.error with the formatted
    // message. This covers the regression that motivated moving the toast
    // out of the swallowed-error path.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("quota");
    // onError also revalidates the thread list so a failed run's status
    // update reaches the sidebar.
    expect(historyRevalidate).toHaveBeenCalled();
  });

  it("stopStream during an active run records a stop call and clears loading on next tick", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    // Start a run and confirm we're loading.
    act(() => {
      result.current.sendMessage("hi");
      stream.setLoading(true);
    });
    expect(result.current.isLoading).toBe(true);

    // User hits Stop.
    act(() => {
      result.current.stopStream();
    });
    expect(stream.getStopCallCount()).toBe(1);

    // The SDK signals settle after stopping.
    act(() => {
      stream.setLoading(false);
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("stopStream while an interrupt is pending still records a stop call (no crash)", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      result.current.sendMessage("hi");
      stream.setInterrupt({
        value: { action_requests: [{ name: "execute", args: {} }] },
      });
    });
    expect(result.current.interrupt).toBeDefined();

    // User bails out mid-approval.
    act(() => {
      result.current.stopStream();
    });
    expect(stream.getStopCallCount()).toBe(1);
    // Interrupt state is still there until the SDK clears it — stopStream
    // doesn't manipulate our fetchedInterrupt / resolvedInterruptKey state.
    expect(result.current.interrupt).toBeDefined();
  });
});
