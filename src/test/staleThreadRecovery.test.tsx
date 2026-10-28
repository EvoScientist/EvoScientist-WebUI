// @vitest-environment jsdom

import { act, waitFor } from "@testing-library/react";
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
  initialThreadId: "5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69" as string | null,
  setThreadId: vi.fn(),
  // Moves the rendered hook to another thread, as navigating does.
  switchTo: null as ((next: string | null) => void) | null,
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
      queryState.switchTo = setThreadId;
      return [threadId, updateThreadId];
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import type { Message } from "@langchain/langgraph-sdk";
import {
  isMissingThreadOrAssistantError,
  missingThreadIdFromError,
} from "@/lib/streamError";
import { renderChat } from "@/test/renderChat";
import { mockProjects } from "@/test/mockProjects";

/** The open thread is gone on the server: the run-path 404 is about it. */
function threadGone() {
  getActiveMockClient().threads.get.mockRejectedValue(
    Object.assign(new Error('HTTP 404: {"detail":"Thread not found."}'), {
      status: 404,
    })
  );
}

describe("stale thread recovery", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    queryState.initialThreadId = "5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69";
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

  it("sends nothing while the assistant is not known", () => {
    const { result } = renderChat({ connected: false });

    let sent = true;
    act(() => {
      sent = result.current.sendMessage("hi");
    });

    expect(sent).toBe(false);
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("clears a stale thread after the explicit SDK 404", async () => {
    threadGone();
    renderChat({ connected: false });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() =>
      expect(queryState.setThreadId).toHaveBeenCalledWith(null)
    );
    expect(toast.error).toHaveBeenCalledWith(
      "This conversation is no longer available. Started a new chat."
    );
  });

  it("hands recovery to onThreadUnavailable when the page provides it", async () => {
    threadGone();
    const onThreadUnavailable = vi.fn();
    renderChat({ connected: false, onThreadUnavailable });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() => expect(onThreadUnavailable).toHaveBeenCalled());
    expect(onThreadUnavailable).toHaveBeenCalledWith({
      threadId: "5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69",
      unsentMessage: null,
    });
    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "This conversation is no longer available. Started a new chat."
    );
  });

  it("reports the just-sent message as unsent when the submit itself 404s", async () => {
    threadGone();
    const onThreadUnavailable = vi.fn();
    const { result } = renderChat({
      connected: true,
      onThreadUnavailable,
    });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.sendMessage("hello there");
    });
    const sent = stream.getSubmitCalls()[0]?.values as {
      messages: Message[];
    };
    act(() => {
      stream.setMessages([...sent.messages]);
    });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() =>
      expect(onThreadUnavailable).toHaveBeenCalledWith({
        threadId: "5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69",
        unsentMessage: "hello there",
      })
    );
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("back in the composer")
    );
  });

  it("stays quiet when the page rejects the report as stale", async () => {
    threadGone();
    const onThreadUnavailable = vi.fn(() => false);
    renderChat({ connected: false, onThreadUnavailable });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() => expect(onThreadUnavailable).toHaveBeenCalledTimes(1));
    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ignores a 404 that lands after the hook instance unmounted", () => {
    const onThreadUnavailable = vi.fn();
    const { unmount } = renderChat({
      connected: false,
      onThreadUnavailable,
    });
    unmount();

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    expect(onThreadUnavailable).not.toHaveBeenCalled();
    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not clear the URL for unrelated errors", () => {
    renderChat({ connected: false });

    act(() => {
      stream.emitError(new Error("HTTP 404: Workspace file not found."));
      stream.emitError(
        new Error('HTTP 500: {"detail":"Thread or assistant not found."}')
      );
    });

    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it("ignores a history 404 that names a thread other than the open one", () => {
    const onThreadUnavailable = vi.fn();
    renderChat({ connected: false, onThreadUnavailable });

    act(() => {
      stream.emitError(
        new Error(
          'HTTP 404: {"detail":"Thread with ID 0b7e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4 not found"}'
        )
      );
    });

    expect(onThreadUnavailable).not.toHaveBeenCalled();
    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("drops a late history 404 once the URL has no thread", () => {
    queryState.initialThreadId = null;
    const onThreadUnavailable = vi.fn();
    renderChat({ connected: false, onThreadUnavailable });

    act(() => {
      stream.emitError(
        new Error(
          'HTTP 404: {"detail":"Thread with ID 5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69 not found"}'
        )
      );
    });

    expect(onThreadUnavailable).not.toHaveBeenCalled();
    expect(queryState.setThreadId).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reads the projects again when a new chat's run 404s", async () => {
    queryState.initialThreadId = null;
    const projects = mockProjects();
    renderChat({ connected: false, projects });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() => expect(projects.refresh).toHaveBeenCalled());
    expect(queryState.setThreadId).not.toHaveBeenCalled();
  });

  it("keeps an open thread when checking it fails for another reason", async () => {
    getActiveMockClient().threads.get.mockRejectedValue(
      new TypeError("Failed to fetch")
    );
    const projects = mockProjects();
    const onThreadUnavailable = vi.fn();
    renderChat({ connected: false, onThreadUnavailable, projects });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() => expect(projects.refresh).toHaveBeenCalled());
    expect(onThreadUnavailable).not.toHaveBeenCalled();
  });

  it("keeps an open thread that still exists when its run 404s", async () => {
    const projects = mockProjects();
    const onThreadUnavailable = vi.fn();
    renderChat({ connected: false, onThreadUnavailable, projects });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    await waitFor(() => expect(projects.refresh).toHaveBeenCalled());
    expect(onThreadUnavailable).not.toHaveBeenCalled();
    expect(queryState.setThreadId).not.toHaveBeenCalled();
  });

  it("hands the message to the composer at once when its run 404s for a missing assistant", async () => {
    const projects = mockProjects();
    const { result } = renderChat({ projects });
    await waitFor(() => expect(result.current.canSend).toBe(true));
    const handBack = vi.fn();
    act(() => {
      result.current.setRefusalHandler(handBack);
    });

    act(() => {
      result.current.sendMessage("hello there");
    });
    const sent = stream.getSubmitCalls()[0]?.values as {
      messages: Message[];
    };
    act(() => {
      stream.setMessages([...sent.messages]);
    });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    // Back before the backend is asked about the thread.
    expect(handBack).toHaveBeenCalledWith("hello there");
    expect(projects.refresh).toHaveBeenCalled();
    // One toast, once the check has found the assistant missing.
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("no longer served")
    );
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("back in the composer")
    );
  });

  it("hands back nothing that already reached the thread", async () => {
    const { result } = renderChat({ projects: mockProjects() });
    await waitFor(() => expect(result.current.canSend).toBe(true));
    const handBack = vi.fn();
    act(() => {
      result.current.setRefusalHandler(handBack);
    });
    act(() => {
      result.current.sendMessage("hello there");
    });
    const sent = stream.getSubmitCalls()[0]?.values as {
      messages: Message[];
    };
    // The thread has it, and an answer after it.
    act(() => {
      stream.setMessages([
        ...sent.messages,
        { id: "ai-1", type: "ai", content: "Hi." } as Message,
      ]);
    });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    expect(handBack).not.toHaveBeenCalled();
  });

  it("keeps the check of a new chat's refusal once the chat has its thread", async () => {
    queryState.initialThreadId = null;
    const pending: Array<() => void> = [];
    getActiveMockClient().threads.get.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve({})))
    );
    renderChat({ connected: false });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    // The SDK made the thread before the run was refused.
    act(() => {
      queryState.switchTo!("0c4f1e2d-7a6b-4c5d-9e8f-1a2b3c4d5e6f");
    });
    await act(async () => {
      pending.forEach((release) => release());
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("no longer served")
      )
    );
  });

  it("drops the check of a refusal once another thread is open", async () => {
    const pending: Array<() => void> = [];
    getActiveMockClient().threads.get.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve({})))
    );
    const onThreadUnavailable = vi.fn();
    renderChat({ connected: false, onThreadUnavailable });

    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });
    act(() => {
      queryState.switchTo!("0c4f1e2d-7a6b-4c5d-9e8f-1a2b3c4d5e6f");
    });
    await act(async () => {
      pending.forEach((release) => release());
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(onThreadUnavailable).not.toHaveBeenCalled();
  });

  it("sends a handed-back message to the new chat with the draft", async () => {
    threadGone();
    const onThreadUnavailable = vi.fn();
    const { result } = renderChat({ connected: true, onThreadUnavailable });
    await waitFor(() => expect(result.current.canSend).toBe(true));
    act(() => {
      result.current.setRefusalHandler(() => {});
    });

    act(() => {
      result.current.sendMessage("hello there");
    });
    const sent = stream.getSubmitCalls()[0]?.values as {
      messages: Message[];
    };
    act(() => {
      stream.setMessages([...sent.messages]);
    });
    act(() => {
      stream.emitError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      );
    });

    // The page takes it with the composer's draft, so it isn't reported
    // twice.
    await waitFor(() =>
      expect(onThreadUnavailable).toHaveBeenCalledWith({
        threadId: "5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69",
        unsentMessage: null,
      })
    );
    // One toast: the conversation is gone, not the assistant.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("no longer available")
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
    expect(
      isMissingThreadOrAssistantError(
        Object.assign(
          new Error(
            'HTTP 404: {"detail":"Thread with ID 5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69 not found"}'
          ),
          { status: 404 }
        )
      )
    ).toBe(true);
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

describe("missingThreadIdFromError", () => {
  it("extracts the id from history-style 404s and nothing from run-style ones", () => {
    expect(
      missingThreadIdFromError(
        new Error(
          'HTTP 404: {"detail":"Thread with ID 5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69 not found"}'
        )
      )
    ).toBe("5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69");
    expect(
      missingThreadIdFromError(
        new Error(
          'HTTP 404: {"detail":"Thread with ID \'5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69\' not found. Please verify the ID is correct and the thread hasn\'t been deleted or expired."}'
        )
      )
    ).toBe("5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69");
    expect(
      missingThreadIdFromError(
        new Error('HTTP 404: {"detail":"Thread or assistant not found."}')
      )
    ).toBeNull();
  });
});
