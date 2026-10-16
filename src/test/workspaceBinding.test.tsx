// @vitest-environment jsdom
//
// Runs carry the backend's folder, and a thread that belongs elsewhere is
// read-only.

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
import { mockWorkspace, readyWorkspace } from "@/test/mockWorkspace";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";

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

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(workspace.refresh).toHaveBeenCalledTimes(1);
  });
});
