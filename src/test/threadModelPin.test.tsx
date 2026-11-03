// @vitest-environment jsdom
//
// A chat thread keeps the model it runs on: a thread without a pick is
// pinned to the registry's default at its next run, so a later change of
// the default moves only new threads.

import { act, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const NEW_THREAD = "0b6c1d2e-3f40-4a51-8b62-7c83d94e0fa1";
const queryState = vi.hoisted(() => ({
  initialThreadId: null as string | null,
}));
const writePick = vi.hoisted(() => vi.fn(async () => {}));

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
  stampThreadWorkspace: async () => {},
  setThreadModelOverride: writePick,
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
import { mockProjects, readyProjects } from "@/test/mockProjects";

const KEY = "/home/you/projA";
const ready = () => mockProjects(readyProjects(KEY));
const M0 = { name: "m-0", provider: "p-0" };

describe("thread model pin", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    queryState.initialThreadId = null;
    writePick.mockClear();
    vi.mocked(toast.error).mockClear();
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

  const sentModel = (i: number) =>
    (
      stream.getSubmitCalls()[i].options as {
        config: { configurable: Record<string, unknown> };
      }
    ).config.configurable;

  it("pins a new chat to the default and keeps it after the default changes", async () => {
    const opts: Parameters<typeof renderChat>[0] = {
      connected: true,
      defaultModel: M0,
      projects: ready(),
    };
    const { result, rerender } = renderChat(opts);

    act(() => {
      result.current.sendMessage("hi");
    });
    expect(sentModel(0)).toMatchObject({ model: "m-0", model_provider: "p-0" });
    // The thread row doesn't exist yet: the pick is written once it does.
    expect(writePick).not.toHaveBeenCalled();
    act(() => {
      (stream.getOptions()?.onThreadId as (id: string) => void)(NEW_THREAD);
    });
    await waitFor(() =>
      expect(writePick).toHaveBeenCalledWith(NEW_THREAD, {
        model: "m-0",
        model_provider: "p-0",
      })
    );

    opts.defaultModel = { name: "m-1", provider: "p-0" };
    rerender();
    await waitFor(() => expect(result.current.canSend).toBe(true));
    act(() => {
      result.current.sendMessage("again");
    });
    expect(sentModel(1)).toMatchObject({ model: "m-0", model_provider: "p-0" });
  });

  it("pins a thread without a pick at its next run, not when it opens", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() => expect(result.current.canSend).toBe(true));
    expect(writePick).not.toHaveBeenCalled();
    expect(result.current.modelOverride).toBeNull();

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(sentModel(0)).toMatchObject({ model: "m-0", model_provider: "p-0" });
    expect(writePick).toHaveBeenCalledWith(THREAD, {
      model: "m-0",
      model_provider: "p-0",
    });
    expect(result.current.modelOverride).toEqual({
      model: "m-0",
      model_provider: "p-0",
    });
  });

  it("keeps the pin for this session when writing it fails", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    writePick.mockRejectedValueOnce(new Error("offline"));
    const opts: Parameters<typeof renderChat>[0] = {
      defaultModel: M0,
      projects: ready(),
    };
    const { result, rerender } = renderChat(opts);
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.sendMessage("hi");
    });
    expect(sentModel(0)).toMatchObject({ model: "m-0", model_provider: "p-0" });
    await waitFor(() => expect(writePick).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();

    opts.defaultModel = { name: "m-1", provider: "p-0" };
    rerender();
    act(() => {
      result.current.sendMessage("again");
    });
    expect(sentModel(1)).toMatchObject({ model: "m-0", model_provider: "p-0" });
  });

  it("pins a thread at a resume too", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.resumeInterrupt({ decisions: [] });
    });

    expect(sentModel(0)).toMatchObject({ model: "m-0", model_provider: "p-0" });
    expect(writePick).toHaveBeenCalledWith(THREAD, {
      model: "m-0",
      model_provider: "p-0",
    });
  });

  it("keeps a thread's own pick and writes nothing", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "m-2", model_provider: "p-1" },
    });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() =>
      expect(result.current.modelOverride).toEqual({
        model: "m-2",
        model_provider: "p-1",
      })
    );
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(sentModel(0)).toMatchObject({ model: "m-2", model_provider: "p-1" });
    expect(writePick).not.toHaveBeenCalled();
  });

  it("leaves a scheduled task's thread on its own model", async () => {
    openThread({ graph_id: "scheduler", workspace_dir: KEY });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(sentModel(0)).not.toHaveProperty("model");
    expect(writePick).not.toHaveBeenCalled();
  });

  it("sends no model when the registry has no default", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const { result } = renderChat({ defaultModel: null, projects: ready() });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(sentModel(0)).not.toHaveProperty("model");
    expect(writePick).not.toHaveBeenCalled();
  });

  it("pins a default without a provider by name only", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const { result } = renderChat({
      defaultModel: { name: "m-0", provider: null },
      projects: ready(),
    });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(sentModel(0)).toMatchObject({ model: "m-0" });
    expect(sentModel(0)).not.toHaveProperty("model_provider");
    expect(writePick).toHaveBeenCalledWith(THREAD, { model: "m-0" });
  });

  it("says how to move a thread kept on another model when its run fails", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "m-2", model_provider: "p-1" },
    });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() => expect(result.current.modelOverride).not.toBeNull());

    act(() => {
      stream.emitError({
        error: "AuthenticationError",
        message: "p-1 API key missing",
        provider: "p-1",
      });
    });

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("p-1 API key missing"),
      {
        description:
          "This chat runs on m-2 (p-1). /model reset moves it to m-0 (p-0).",
      }
    );
  });

  it("adds nothing to an error that isn't the model's", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "m-2", model_provider: "p-1" },
    });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() => expect(result.current.modelOverride).not.toBeNull());

    act(() => {
      stream.emitError(
        Object.assign(new Error("recursion limit"), {
          name: "GraphRecursionError",
        })
      );
    });

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("recursion limit"),
      undefined
    );
  });

  it("adds nothing to a run error on a thread on the default", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: KEY,
      model_override: { model: "m-0", model_provider: "p-0" },
    });
    const { result } = renderChat({ defaultModel: M0, projects: ready() });
    await waitFor(() => expect(result.current.modelOverride).not.toBeNull());

    act(() => {
      stream.emitError({
        error: "RateLimitError",
        message: "provider quota exceeded",
        provider: "p-0",
      });
    });

    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("quota"),
      undefined
    );
  });
});
