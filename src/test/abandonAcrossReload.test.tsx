// @vitest-environment jsdom
//
// Scenario: the user abandoned a tool-approval interrupt (Stop / Reject) in a
// previous session, and its key was persisted to localStorage. On reload the
// thread's pending interrupt comes back over the live stream — but because it
// was abandoned, `useChat` must keep it suppressed until the user moves forward.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
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

// A fixed, non-null threadId so the persisted per-thread abandon set is in play
// (persistence is keyed by threadId; a null/new chat doesn't persist).
const THREAD_ID = "t-reload";

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
    useQueryState: () => react.useState<string | null>(THREAD_ID),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { renderChat } from "@/test/renderChat";
import { fixtureAssistantWithConfig as fixtureAssistant } from "@/test/fixtures/assistants";
import { interruptValueKey } from "@/app/hooks/useChat";
import { addAbandonedInterruptKey } from "@/lib/abandonedInterrupts";

const approval = {
  value: { action_requests: [{ name: "execute", args: { command: "ls" } }] },
};

describe("abandon survives reload", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    localStorage.clear();
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    localStorage.clear();
  });

  it("keeps a previously-abandoned approval suppressed, then lets it back after moving forward", () => {
    // Simulate the prior session: the interrupt's key was persisted on abandon.
    addAbandonedInterruptKey(THREAD_ID, interruptValueKey(approval));

    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    // Reload delivers the still-pending interrupt over the live stream.
    act(() => {
      stream.setInterrupt(approval);
    });
    // It stays suppressed — the persisted abandon key wins.
    expect(result.current.interrupt).toBeUndefined();

    // Moving forward (a new message) forgets the abandon...
    act(() => {
      result.current.sendMessage("do it differently");
    });
    // ...so a fresh occurrence of the same approval now surfaces normally.
    act(() => {
      stream.setInterrupt(approval);
    });
    expect(result.current.interrupt).toBeDefined();
  });
});
