// @vitest-environment jsdom
//
// Runs carry the backend's folder, and a thread that belongs elsewhere is
// read-only.

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
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

const THREAD = "5f2c8e6a-9b1d-4c3e-8a7f-1d2e3c4b5a69";
const queryState = vi.hoisted(() => ({
  initialThreadId: null as string | null,
}));
const stamp = vi.hoisted(() => vi.fn(async () => {}));

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

vi.mock("@/app/hooks/useThreads", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stampThreadWorkspace: stamp,
  setThreadModelOverride: async () => {},
}));

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () =>
      react.useState<string | null>(queryState.initialThreadId),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { renderChat } from "@/test/renderChat";
import {
  TestWorkspaceProvider,
  mockWorkspace,
  readyWorkspace,
} from "@/test/mockWorkspace";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import { useThreads } from "@/app/hooks/useThreads";
import type { WorkspaceContextValue } from "@/providers/WorkspaceProvider";

const KEY = "/home/you/projA";
const ready = () => mockWorkspace(readyWorkspace(KEY));

describe("workspace binding", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    queryState.initialThreadId = null;
    stamp.mockClear();
    vi.mocked(toast.error).mockReset();
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  function openThread(metadata: Record<string, unknown>) {
    queryState.initialThreadId = THREAD;
    getActiveMockClient().setThreadRecord(THREAD, { metadata });
  }

  it("creates a new thread with the backend's folder", () => {
    const { result } = renderChat({
      connected: true,
      workspace: ready(),
    });

    act(() => {
      result.current.sendMessage("hi");
    });

    const options = stream.getSubmitCalls()[0].options as {
      metadata?: Record<string, unknown>;
    };
    expect(options.metadata).toEqual({ workspace_dir: KEY });
  });

  it("makes a thread of another folder read-only", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: "/home/you/projB" });
    const { result } = renderChat({
      connected: true,
      workspace: ready(),
    });

    await waitFor(() => expect(result.current.binding.kind).toBe("readOnly"));
    let sent = true;
    let resumed = true;
    act(() => {
      sent = result.current.sendMessage("hi");
      resumed = result.current.resumeInterrupt({ decisions: [] });
    });

    expect([sent, resumed]).toEqual([false, false]);
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("keeps a model picked on a thread when its folder is stamped", async () => {
    openThread({ graph_id: "EvoScientist" });
    const { result } = renderChat({ workspace: ready() });
    await waitFor(() => expect(result.current.binding.kind).toBe("unbound"));

    await act(async () => {
      await result.current.setModelOverride({ model: "m-2" });
    });
    act(() => {
      result.current.sendMessage("hi");
    });

    expect(result.current.modelOverride).toEqual({ model: "m-2" });
  });

  it("stamps the folder on a thread with none when it resumes", async () => {
    openThread({ graph_id: "EvoScientist" });
    const { result } = renderChat({ workspace: ready() });
    await waitFor(() => expect(result.current.binding.kind).toBe("unbound"));

    act(() => {
      result.current.resumeInterrupt({ decisions: [] });
    });

    expect(stamp).toHaveBeenCalledWith(THREAD, KEY);
  });

  it("keeps a model picked before the thread's metadata arrives", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "old" },
    });
    const { result } = renderChat({ workspace: ready() });

    // Picked in the same tick as opening, before the thread's read lands.
    await act(async () => {
      await result.current.setModelOverride({ model: "new" });
    });
    await waitFor(() => expect(result.current.binding.kind).toBe("open"));

    expect(result.current.modelOverride).toEqual({ model: "new" });
  });

  it("reads a thread's folder from its newest checkpoint", async () => {
    openThread({ graph_id: "EvoScientist" });
    stream.setHistory([
      { metadata: {} },
      { metadata: { workspace_dir: "/home/you/projB" } },
    ]);
    const { result } = renderChat({ workspace: ready() });

    await waitFor(() => expect(result.current.binding.kind).toBe("readOnly"));
  });

  it("stamps the backend's folder on a thread that had none", async () => {
    openThread({ graph_id: "EvoScientist" });
    const { result } = renderChat({
      connected: true,
      workspace: ready(),
    });
    await waitFor(() => expect(result.current.binding.kind).toBe("unbound"));

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(stamp).toHaveBeenCalledWith(THREAD, KEY);
    expect(stream.getSubmitCalls()).toHaveLength(1);

    // Stamped once: the thread now reads as this folder's.
    expect(result.current.binding.kind).toBe("open");
    act(() => {
      result.current.sendMessage("again");
    });
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  it("reads the folder and the model override from the thread's metadata", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "m-1", model_provider: "p-1" },
    });
    const { result } = renderChat({ workspace: ready() });

    await waitFor(() =>
      expect(result.current.modelOverride).toEqual({
        model: "m-1",
        model_provider: "p-1",
      })
    );
    expect(result.current.binding.kind).toBe("open");
  });

  it("runs a scheduled task's thread on the scheduler assistant", async () => {
    openThread({ graph_id: "scheduler", workspace_dir: KEY });
    const workspace = ready();
    renderChat({ connected: true, workspace });

    await waitFor(() =>
      expect(stream.getOptions()?.assistantId).toBe(
        workspaceAssistantId("scheduler", KEY)
      )
    );
  });

  it("sends nothing while the folder is being read again", () => {
    const workspace = {
      ...ready(),
      refreshing: true,
      isReady: () => false,
    };
    const { result } = renderChat({
      connected: true,
      workspace,
    });

    let sent = true;
    act(() => {
      sent = result.current.sendMessage("hi");
    });

    expect(sent).toBe(false);
    expect(result.current.canSend).toBe(false);
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("checks the gate at the moment of sending", () => {
    let readyNow = true;
    const workspace = { ...ready(), isReady: () => readyNow };
    const { result } = renderChat({
      connected: true,
      workspace,
    });

    // A refresh started after the last render.
    readyNow = false;
    let sent = true;
    act(() => {
      sent = result.current.sendMessage("hi");
    });

    expect(sent).toBe(false);
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  it("asks the backend again after a folder mismatch and explains a refusal", async () => {
    const workspace = ready();
    renderChat({ connected: true, workspace });

    act(() => {
      stream.emitError(
        Object.assign(
          new Error("This EvoScientist server serves workspace /x"),
          {
            name: "RunFolderMismatchError",
          }
        )
      );
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("serves workspace /x")
      )
    );
    expect(workspace.refresh).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the read after a mismatch is cut short by another backend", async () => {
    vi.mocked(toast.info).mockClear();
    // The read was aborted by a switch to another backend: it has no answer.
    const workspace = {
      ...ready(),
      refresh: vi.fn(async () => ({ status: "pending" } as const)),
    };
    renderChat({ connected: true, workspace });

    act(() => {
      stream.emitError(
        Object.assign(
          new Error("This EvoScientist server serves workspace /x"),
          {
            name: "RunFolderMismatchError",
          }
        )
      );
    });

    await waitFor(() => expect(workspace.refresh).toHaveBeenCalled());
    await act(async () => {});
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("forgets the thread's folder on another backend until that one answers", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const { result, rerender } = renderChat({ workspace: ready() });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    // Another backend, whose answer for the thread hasn't come yet.
    const other = new MockClient();
    other.threads.get.mockImplementation(() => new Promise(() => {}));
    installMockClient(other);
    rerender();

    expect(result.current.binding.kind).toBe("pending");
    expect(result.current.canSend).toBe(false);
  });

  it("sends only the model override in the run config", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "m-1", model_provider: "p-1" },
    });
    const { result } = renderChat({ workspace: ready() });
    await waitFor(() => expect(result.current.canSend).toBe(true));
    await waitFor(() =>
      expect(result.current.modelOverride).toEqual({
        model: "m-1",
        model_provider: "p-1",
      })
    );

    act(() => {
      result.current.sendMessage("hi");
    });

    const options = stream.getSubmitCalls()[0].options as { config?: unknown };
    expect(options.config).toEqual({
      configurable: { model: "m-1", model_provider: "p-1" },
    });
  });

  it("runs the chat on the folder's assistant", () => {
    renderChat({ workspace: ready() });
    expect(stream.getOptions()?.assistantId).toBe(
      workspaceAssistantId("EvoScientist", KEY)
    );
  });

  it("addresses the chat graph by name on a core without the route", () => {
    renderChat({ connected: true });
    expect(stream.getOptions()?.assistantId).toBe("EvoScientist");
  });
});

describe("thread list", () => {
  beforeEach(() => {
    localStorage.setItem(
      "evoscientist-config",
      JSON.stringify({ deploymentUrl: "http://127.0.0.1:6174" })
    );
  });

  afterEach(() => {
    localStorage.removeItem("evoscientist-config");
    vi.unstubAllGlobals();
  });

  async function searchedMetadata(workspace: WorkspaceContextValue) {
    const bodies: Array<{ metadata?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/threads/search")) {
          bodies.push(JSON.parse(String(init?.body)));
        }
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    renderHook(() => useThreads({}), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SWRConfig value={{ provider: () => new Map() }}>
          <TestWorkspaceProvider value={workspace}>
            {children}
          </TestWorkspaceProvider>
        </SWRConfig>
      ),
    });
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    return bodies[0].metadata;
  }

  it("lists the chat threads of the backend's folder", async () => {
    expect(await searchedMetadata(ready())).toEqual({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
    });
  });

  it("lists the chat graph's threads on a core without the route", async () => {
    expect(await searchedMetadata(mockWorkspace())).toEqual({
      graph_id: "EvoScientist",
    });
  });
});
