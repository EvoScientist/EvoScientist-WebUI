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

  it("stops suppressing once the server shows a newer turn than the one that was stopped", async () => {
    // Stop belongs to the turn it was pressed on. If another tab or a cron run
    // then starts a new turn on this thread and pauses for approval, that
    // approval is not the abandoned run's and must be shown.
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      stream.setMessages(serverMessages);
      stream.setLoading(true);
    });
    act(() => {
      result.current.abortRun();
    });
    getActiveMockClient().setThreadState("t-1", {
      next: ["tools"],
      tasks: [{ interrupts: [{ ...pendingApproval, id: "int-srv-2" }] }],
      values: {
        messages: [
          ...serverMessages,
          { id: "h2", type: "human", content: "scheduled run" },
          {
            id: "a2",
            type: "ai",
            content: "",
            tool_calls: [
              { id: "tc2", name: "execute", args: { command: "ls" } },
            ],
          },
        ] as unknown as Message[],
      },
    });
    act(() => {
      stream.setLoading(false);
    });
    await waitFor(() => expect(result.current.interrupt).toBeDefined());
    expect(result.current.runSettled).toBe(false);
  });

  it.each([
    ["with an ID", pendingApproval],
    ["without an ID", { value: pendingApproval.value }],
    ["as an array", [pendingApproval]],
  ])(
    "keeps the poll bounded when live interrupt identity churns %s",
    async (_label, liveInterrupt) => {
      // A live interrupt is present (e.g. the next parallel sub-agent re-raised
      // after one approval) and the stream is idle. The SDK hands back a fresh
      // interrupt object per render; unrelated store notifications must NOT
      // re-run the recovery effect and re-issue getState/get.
      const { result } = renderChat({ activeAssistant: fixtureAssistant });
      act(() => {
        stream.setInterrupt(liveInterrupt);
      });
      await waitFor(() => {
        expect(result.current.interrupt).toBeDefined();
      });
      // Let the first poll settle.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const client = getActiveMockClient();
      const settled = client.threads.getState.mock.calls.length;

      // 30 unrelated notifications = 30 renders = 30 fresh interrupt objects.
      for (let i = 0; i < 30; i++) {
        act(() => {
          stream.setMessages([...stream.getSnapshot().messages]);
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(client.threads.getState.mock.calls.length).toBe(settled);
      expect(result.current.interrupt).toBeDefined();
    }
  );

  it("recovers a new approval ID even when the tool arguments are identical", async () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    await waitFor(() => {
      expect(result.current.interrupt).toEqual(pendingApproval);
    });
    const client = getActiveMockClient();
    const settled = client.threads.getState.mock.calls.length;
    const nextApproval = { ...pendingApproval, id: "int-srv-2" };
    const nextMessages = [
      ...serverMessages,
      { id: "a2", type: "ai", content: "Second approval" },
    ] as Message[];
    client.setThreadState("t-1", {
      next: ["tools"],
      tasks: [{ interrupts: [nextApproval] }],
      values: { messages: nextMessages },
    });
    act(() => {
      stream.setInterrupt(nextApproval);
    });
    await waitFor(() => {
      expect(result.current.interrupt).toEqual(nextApproval);
      expect(result.current.messages.map((m) => m.id)).toEqual([
        "h1",
        "a1",
        "a2",
      ]);
    });
    expect(client.threads.getState.mock.calls.length).toBe(settled + 1);
  });
});

// A tool call with no result spins only while something can still produce one.
// `runSettled` is the hook's word that nothing can: the server says the thread is
// not busy and has no approval pending, or the user pressed Stop.
describe("runSettled", () => {
  let stream: MockStreamStore;
  const seedDangling = (status: string | undefined) => {
    const client = getActiveMockClient();
    client.setThreadState("t-1", {
      next: ["tools"], // a cancelled run leaves `next` populated for good
      tasks: [],
      values: { messages: serverMessages },
    });
    client.setThreadRecord("t-1", status === undefined ? {} : { status });
  };

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  it("is true once the server reports the thread is not busy and nothing is pending", async () => {
    seedDangling("interrupted");
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    expect(result.current.runSettled).toBe(false);
    await waitFor(() => expect(result.current.runSettled).toBe(true));
  });

  it("stays false while the server is still busy (the stream settled early)", async () => {
    seedDangling("busy");
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    const client = getActiveMockClient();
    await waitFor(() =>
      expect(client.threads.get.mock.calls.length).toBeGreaterThan(0)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.runSettled).toBe(false);
  });

  it("stays false when the server gives no status to go on", async () => {
    seedDangling(undefined);
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    const client = getActiveMockClient();
    await waitFor(() =>
      expect(client.threads.get.mock.calls.length).toBeGreaterThan(0)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.runSettled).toBe(false);
  });

  it("stays false while an approval is pending, even on a non-busy thread", async () => {
    const client = getActiveMockClient();
    client.setThreadState("t-1", {
      next: ["tools"],
      tasks: [{ interrupts: [pendingApproval] }],
      values: { messages: serverMessages },
    });
    client.setThreadRecord("t-1", { status: "interrupted" });
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    await waitFor(() => expect(result.current.interrupt).toBeDefined());
    expect(result.current.runSettled).toBe(false);
  });

  it("does not settle on a status it does not recognise", async () => {
    seedDangling("queued");
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    const client = getActiveMockClient();
    await waitFor(() =>
      expect(client.threads.get.mock.calls.length).toBeGreaterThan(0)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.runSettled).toBe(false);
  });

  it("takes it back when a later poll finds the thread busy again", async () => {
    // `next` stays populated after a cancel, so the poll keeps going; if a run
    // started elsewhere picks the thread up, its calls must spin again.
    seedDangling("interrupted");
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    await waitFor(() => expect(result.current.runSettled).toBe(true));
    getActiveMockClient().setThreadRecord("t-1", { status: "busy" });
    await waitFor(() => expect(result.current.runSettled).toBe(false), {
      timeout: 3000,
    });
  });

  it("takes it back when an approval turns up on a thread it had called settled", async () => {
    seedDangling("interrupted");
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    await waitFor(() => expect(result.current.runSettled).toBe(true));
    getActiveMockClient().setThreadState("t-1", {
      next: ["tools"],
      tasks: [{ interrupts: [pendingApproval] }],
      values: { messages: serverMessages },
    });
    await waitFor(() => expect(result.current.interrupt).toBeDefined(), {
      timeout: 3000,
    });
    expect(result.current.runSettled).toBe(false);
  });

  it("is true as soon as the user stops the run, and false again once a run streams", async () => {
    seedDangling("busy");
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      stream.setLoading(true);
    });
    expect(result.current.runSettled).toBe(false);
    act(() => {
      result.current.abortRun();
    });
    act(() => {
      stream.setLoading(false);
    });
    expect(result.current.runSettled).toBe(true);

    act(() => {
      stream.setLoading(true);
    });
    expect(result.current.runSettled).toBe(false);
  });
});
