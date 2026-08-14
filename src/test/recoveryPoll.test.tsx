// @vitest-environment jsdom
//
// Scenario: the recovery poll — the bounded threads.getState fallback that
// backfills a tool-approval interrupt after the live SSE stream settles early.
// Other suites mount with a null threadId, so the poll effect never runs
// there; these tests mock nuqs with a real thread id to exercise it: the poll
// must surface a pending server-side approval on the normal path, and
// suppress that same approval (while still backfilling the dropped tail)
// after the user hit Stop.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
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

// The poll only runs for a real thread; useChat reads exactly one query state
// ("threadId"), so a non-null initial value here activates it.
vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>("t-1"),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { renderChat } from "@/test/renderChat";
import { fixtureAssistantWithConfig as fixtureAssistant } from "@/test/fixtures/assistants";

const serverMessages = [
  { id: "h1", type: "human", content: "run it" },
  {
    id: "a1",
    type: "ai",
    content: "",
    tool_calls: [{ id: "tc1", name: "execute", args: { command: "ls" } }],
  },
] as unknown as Message[];

const pendingApproval = {
  id: "int-srv-1",
  value: { action_requests: [{ name: "execute", args: { command: "ls" } }] },
};

function seedPausedThread() {
  const client = getActiveMockClient();
  client.setThreadState("t-1", {
    next: ["tools"],
    tasks: [{ interrupts: [pendingApproval] }],
    values: { messages: serverMessages },
  });
  client.setThreadRecord("t-1", {});
}

describe("recovery poll", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
    seedPausedThread();
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  it("surfaces a pending server-side approval the settled stream dropped", async () => {
    // The live stream settled with nothing: the poll must backfill both the
    // approval interrupt and the dropped tail from thread state. This also
    // proves the fixture is genuinely actionable — the Stop test below would
    // otherwise pass vacuously.
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    await waitFor(() => {
      expect(result.current.interrupt).toBeDefined();
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(["h1", "a1"]);
    });
  });

  it("suppresses the polled approval after Stop but still backfills the tail", async () => {
    // Stop while the run streams, then the stream settles: the poll finds the
    // approval the aborted run paused on and must NOT re-surface it — the
    // bounce-back this PR removes — while the partial turn's messages still
    // arrive.
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      stream.setLoading(true);
    });
    act(() => {
      result.current.abortRun();
    });
    expect(stream.getStopCallCount()).toBe(1);
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(["h1", "a1"]);
    });
    expect(result.current.interrupt).toBeUndefined();

    // Settling on the paused approval must also END the poll (both the abort
    // and the surface branch return) — suppression must never degrade into
    // hitting getState every second for the rest of the bounded window.
    const client = getActiveMockClient();
    const settled = client.threads.getState.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(client.threads.getState.mock.calls.length).toBe(settled);
    expect(result.current.interrupt).toBeUndefined();
  });
});
