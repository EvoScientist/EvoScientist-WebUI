// @vitest-environment jsdom
//
// Each thread runs in its own project, a new chat in the current one; a
// thread of a folder that isn't a project is read-only.

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
import { mockProjects, readyProjects } from "@/test/mockProjects";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import { useThreads } from "@/app/hooks/useThreads";
import type { ThreadScope } from "@/app/hooks/useThreads";

const KEY = "/home/you/projA";
const OTHER = "/srv/projB";
const ready = () => mockProjects(readyProjects(KEY));
/** Two projects, the first current. */
const both = () => mockProjects(readyProjects(KEY, OTHER), { current: KEY });

describe("project binding", () => {
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

  it.each(["thread", "checkpoint"])(
    "keeps a read-only run-folder conversation's project from its %s",
    async (source) => {
      const folders = { workspace_dir: OTHER, run_dir: `${OTHER}/runs/r1` };
      openThread({
        graph_id: "EvoScientist",
        ...(source === "thread" ? folders : {}),
      });
      if (source === "checkpoint") stream.setHistory([{ metadata: folders }]);
      const projects = both();
      const { result } = renderChat({ projects });

      await waitFor(() => expect(result.current.projectKey).toBe(OTHER));
      expect(projects.selectProject).toHaveBeenCalledWith(OTHER);
      expect(result.current.binding.kind).toBe("readOnly");
      expect(result.current.canSend).toBe(false);
      act(() => {
        expect(result.current.sendMessage("hi")).toBe(false);
        expect(result.current.resumeInterrupt({ decisions: [] })).toBe(false);
      });
      expect(stream.getSubmitCalls()).toHaveLength(0);
    }
  );

  it.each(["unregistered", "missing"])(
    "keeps a %s folder unavailable when opening a read-only conversation",
    async (state) => {
      openThread({ graph_id: "EvoScientist", workspace_dir: OTHER });
      const projects = mockProjects(
        readyProjects(
          KEY,
          ...(state === "missing"
            ? [{ key: OTHER, name: "B", missing: true }]
            : [])
        ),
        { current: KEY }
      );
      const { result } = renderChat({ projects });

      await waitFor(() => expect(result.current.binding.kind).toBe("readOnly"));
      expect(result.current.projectKey).toBeNull();
      expect(projects.selectProject).not.toHaveBeenCalled();
      expect(result.current.canSend).toBe(false);
    }
  );

  it("names a run-folder conversation's files from its run folder", async () => {
    openThread({
      graph_id: "EvoScientist",
      workspace_dir: OTHER,
      run_dir: `${OTHER}/runs/r1`,
    });
    const { result } = renderChat({ projects: both() });

    await waitFor(() => expect(result.current.runFolder).toBe("runs/r1"));
  });

  it("creates a new thread in the current project", () => {
    const { result } = renderChat({
      connected: true,
      projects: ready(),
    });

    act(() => {
      result.current.sendMessage("hi");
    });

    const options = stream.getSubmitCalls()[0].options as {
      metadata?: Record<string, unknown>;
    };
    expect(options.metadata).toEqual({ workspace_dir: KEY });
  });

  it("makes a thread of a folder that isn't a project read-only", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: "/home/you/projB" });
    const { result } = renderChat({
      connected: true,
      projects: ready(),
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
    const { result } = renderChat({ projects: ready() });
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
    const { result } = renderChat({ projects: ready() });
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
    const { result } = renderChat({ projects: ready() });

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
    const { result } = renderChat({ projects: ready() });

    await waitFor(() => expect(result.current.binding.kind).toBe("readOnly"));
  });

  it("stamps the current project on a thread that had none", async () => {
    openThread({ graph_id: "EvoScientist" });
    const { result } = renderChat({
      connected: true,
      projects: ready(),
    });
    await waitFor(() => expect(result.current.binding.kind).toBe("unbound"));

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(stamp).toHaveBeenCalledWith(THREAD, KEY);
    expect(stream.getSubmitCalls()).toHaveLength(1);

    // Stamped once: the thread now reads as this project's.
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
    const { result } = renderChat({ projects: ready() });

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
    const projects = ready();
    renderChat({ connected: true, projects });

    await waitFor(() =>
      expect(stream.getOptions()?.assistantId).toBe(
        workspaceAssistantId("scheduler", KEY)
      )
    );
  });

  it("sends nothing while the projects are read again", () => {
    const projects = {
      ...ready(),
      refreshing: true,
      isReady: () => false,
    };
    const { result } = renderChat({
      connected: true,
      projects,
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
    const projects = { ...ready(), isReady: () => readyNow };
    const { result } = renderChat({
      connected: true,
      projects,
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

  it("reads the projects again after a folder mismatch and explains it", async () => {
    const projects = ready();
    renderChat({ connected: true, projects });

    act(() => {
      stream.emitError(
        Object.assign(
          new Error("This EvoScientist server serves workspace /x"),
          { name: "RunFolderMismatchError" }
        )
      );
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("serves workspace /x")
      )
    );
    expect(projects.refresh).toHaveBeenCalledTimes(1);
  });

  it("reads the projects again when a state write is refused", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const refused = Object.assign(
      new Error("This EvoScientist server does not serve workspace /x"),
      { status: 409 }
    );
    getActiveMockClient().threads.updateState.mockRejectedValueOnce(refused);
    const projects = ready();
    const { result } = renderChat({ projects });
    await waitFor(() => expect(result.current.canSend).toBe(true));

    await expect(
      act(() => result.current.setFiles({ "/notes.md": "x" }))
    ).rejects.toBe(refused);

    expect(projects.refresh).toHaveBeenCalledTimes(1);
  });

  it("forgets the thread's folder on another backend until that one answers", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
    const { result, rerender } = renderChat({ projects: ready() });
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
    const { result } = renderChat({ projects: ready() });
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

  it("runs a new chat on the current project's assistant", () => {
    renderChat({ projects: ready() });
    expect(stream.getOptions()?.assistantId).toBe(
      workspaceAssistantId("EvoScientist", KEY)
    );
  });

  it("runs a thread of another project on that project's assistant", async () => {
    openThread({ graph_id: "EvoScientist", workspace_dir: OTHER });
    const projects = both();
    const { result } = renderChat({ projects });

    await waitFor(() =>
      expect(result.current.binding).toEqual({ kind: "open", key: OTHER })
    );
    expect(stream.getOptions()?.assistantId).toBe(
      workspaceAssistantId("EvoScientist", OTHER)
    );
    expect(result.current.canSend).toBe(true);
    // Its project becomes the current one, not yet the last used.
    expect(projects.selectProject).toHaveBeenCalledWith(OTHER);
  });

  it("remembers the project a message is sent in", () => {
    const projects = both();
    const { result } = renderChat({ projects });

    act(() => {
      result.current.sendMessage("hi");
    });

    expect(projects.selectProject).toHaveBeenCalledWith(KEY, {
      remember: true,
    });
  });

  it("runs nothing on a core without the project list", () => {
    const { result } = renderChat({
      projects: mockProjects({ status: "unsupported" }),
    });

    expect(result.current.binding.kind).toBe("readOnly");
    expect(result.current.canSend).toBe(false);
    expect(stream.getOptions()?.assistantId).toBe("");
  });

  it("runs nothing without a project", () => {
    const { result } = renderChat({
      projects: mockProjects(readyProjects(), { current: null }),
    });

    expect(result.current.binding.kind).toBe("readOnly");
    expect(result.current.canSend).toBe(false);
  });

  it.each(["ProjectNotServedError", "NoProjectError"])(
    "reads the projects again after a %s and says the project is gone",
    async (name) => {
      openThread({ graph_id: "EvoScientist", workspace_dir: KEY });
      const projects = ready();
      const { result } = renderChat({ projects });
      await waitFor(() => expect(result.current.canSend).toBe(true));

      act(() => {
        stream.emitError(Object.assign(new Error("refused"), { name }));
      });

      expect(projects.refresh).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("no longer served")
      );
      // A conversation that already existed is kept.
      expect(getActiveMockClient().threads.delete).not.toHaveBeenCalled();
    }
  );

  it("starts a new chat with the message when a new chat's project is gone", async () => {
    const onThreadUnavailable = vi.fn(() => ({ unsentBack: true }));
    const projects = ready();
    const { result } = renderChat({ projects, onThreadUnavailable });

    act(() => {
      result.current.sendMessage("hi");
    });
    const sent = (
      stream.getSubmitCalls()[0].values as { messages: Array<{ id: string }> }
    ).messages;
    // The run made the thread, then the core refused it.
    act(() => {
      stream.setMessages(sent as never);
      (stream.getOptions()?.onThreadId as (id: string) => void)(THREAD);
    });
    await waitFor(() => expect(result.current.binding.kind).not.toBe("open"));
    act(() => {
      stream.emitError(
        Object.assign(new Error("refused"), { name: "ProjectNotServedError" })
      );
    });

    expect(onThreadUnavailable).toHaveBeenCalledWith({
      threadId: THREAD,
      unsentMessage: "hi",
    });
    // The empty thread the refused run made is deleted.
    expect(getActiveMockClient().threads.delete).toHaveBeenCalledWith(THREAD);
    expect(projects.refresh).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("no longer served")
    );
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

  /** The first search a list makes, and the pages it shows. */
  async function search(
    scope: ThreadScope | null,
    threads: unknown[] = [],
    limit?: number
  ) {
    const bodies: Array<{ metadata?: unknown; status?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/threads/search")) {
          bodies.push(JSON.parse(String(init?.body)));
        }
        return new Response(JSON.stringify(threads), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { result } = renderHook(
      () => useThreads({ scope, status: "busy", limit }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <SWRConfig value={{ provider: () => new Map() }}>
            {children}
          </SWRConfig>
        ),
      }
    );
    return { bodies, result };
  }

  it("lists a project's chat threads", async () => {
    const { bodies } = await search({ project: KEY });
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(bodies[0]).toMatchObject({
      metadata: { graph_id: "EvoScientist", workspace_dir: KEY },
      status: "busy",
    });
  });

  const raw = (id: string, metadata: Record<string, unknown>) => ({
    thread_id: id,
    status: "busy",
    updated_at: "2026-10-28T10:00:00Z",
    metadata: {
      auto_title: "x",
      preview: "y",
      labels_state_at: "2026-10-28T10:00:00Z",
      ...metadata,
    },
  });

  it("keeps the named projects' threads from a search across folders", async () => {
    const { bodies, result } = await search({ projects: [KEY] }, [
      raw("in", { workspace_dir: KEY }),
      raw("other", { workspace_dir: "/home/you/projC" }),
      raw("none", {}),
    ]);

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(bodies[0].metadata).toEqual({ graph_id: "EvoScientist" });
    expect(result.current.data?.[0].items.map((t) => t.id)).toEqual(["in"]);
  });

  it("keeps only threads with no folder for No project", async () => {
    const { result } = await search("noProject", [
      raw("in", { workspace_dir: KEY }),
      raw("none", {}),
    ]);

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.[0].items.map((t) => t.id)).toEqual(["none"]);
  });

  it("reads each thread's folders, and whether the page was full", async () => {
    const { result } = await search(
      { projects: [KEY] },
      [
        {
          thread_id: "t-1",
          status: "busy",
          updated_at: "2026-10-28T10:00:00Z",
          metadata: {
            workspace_dir: KEY,
            run_dir: `${KEY}/runs/r1`,
            title: "x",
            auto_title: "x",
            preview: "y",
            labels_state_at: "2026-10-28T10:00:00Z",
          },
        },
      ],
      1
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.[0]).toMatchObject({
      full: true,
      items: [{ workspaceDir: KEY, runDir: `${KEY}/runs/r1` }],
    });
  });

  it("searches nothing without a scope", async () => {
    const { bodies } = await search(null);
    await act(async () => {});
    expect(bodies).toHaveLength(0);
  });
});
