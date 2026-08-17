// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
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

const queryState = vi.hoisted(() => ({
  initialThreadId: "stale-thread" as string | null,
  setThreadId: vi.fn(),
}));

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
    useQueryState: () => {
      const [threadId, setThreadId] = react.useState<string | null>(
        queryState.initialThreadId
      );
      const updateThreadId = react.useCallback((next: string | null) => {
        queryState.setThreadId(next);
        setThreadId(next);
      }, []);
      return [threadId, updateThreadId];
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { isMissingThreadOrAssistantError } from "@/app/hooks/useChat";
import { renderChat } from "@/test/renderChat";

describe("stale thread recovery", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    queryState.initialThreadId = "stale-thread";
    queryState.setThreadId.mockReset();
    vi.mocked(toast.error).mockReset();
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  it("uses the EvoScientist graph id while assistant discovery is pending", () => {
    renderChat({ activeAssistant: null });

    expect(stream.getOptions()?.assistantId).toBe("EvoScientist");
  });

  it("clears a stale thread after the explicit SDK 404", () => {
    renderChat({ activeAssistant: null });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    expect(queryState.setThreadId).toHaveBeenCalledWith(null);
    expect(toast.error).toHaveBeenCalledWith(
      "This conversation is no longer available. Started a new chat."
    );
  });

  it("does not clear the URL for unrelated errors", () => {
    renderChat({ activeAssistant: null });

    act(() => {
      stream.emitError(new Error("HTTP 404: Workspace file not found."));
      stream.emitError(
        new Error('HTTP 500: {"detail":"Thread or assistant not found."}')
      );
    });

    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it("does not reset an already-new conversation", () => {
    queryState.initialThreadId = null;
    renderChat({ activeAssistant: null });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Error: HTTP 404: {"detail":"Thread or assistant not found."}'
    );
  });
});

describe("isMissingThreadOrAssistantError", () => {
  it("accepts structured 404 errors from the SDK", () => {
    const error = {
      status_code: 404,
      message: "Thread with ID stale-thread not found",
    };

    expect(isMissingThreadOrAssistantError(error)).toBe(true);
  });

  it("requires both a 404 and a missing thread or assistant detail", () => {
    expect(
      isMissingThreadOrAssistantError(
        new Error("Thread or assistant not found without an HTTP status")
      )
    ).toBe(false);
    expect(
      isMissingThreadOrAssistantError(new Error("HTTP 404: Model not found"))
    ).toBe(false);
  });
});
