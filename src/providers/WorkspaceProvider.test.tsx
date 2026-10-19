// @vitest-environment jsdom
//
// The WebUI asks the backend which folder it serves and makes sure the
// folder's assistants exist before anything runs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const create = vi.hoisted(() => vi.fn());
// One client for the provider's life, as ClientProvider memoizes it.
const client = vi.hoisted(() => ({ assistants: { create } }));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => client,
}));

import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";
import { assistantIdFor } from "@/lib/workspaceSession";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import { useSchedulerTarget } from "@/app/hooks/useScheduledTasks";
import { RUN_GRAPHS } from "@/lib/threadBinding";

function json(status: number, body: unknown = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

const served = (key: string) =>
  json(200, { workspace_dir: key, run_dir: null });

/** The backend: `/api/workspace` answers with `folder()`, the local check 404s. */
function stubBackend(folder: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/api/workspace/local") ? json(404) : folder()
    )
  );
}

function renderWorkspace() {
  return renderHook(() => useWorkspace(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceProvider
        deploymentUrl="http://127.0.0.1:6174"
        apiKey=""
      >
        {children}
      </WorkspaceProvider>
    ),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  create.mockReset();
});

describe("WorkspaceProvider", () => {
  it("opens once the folder and its assistants are in", async () => {
    stubBackend(() => served("/home/you/projA"));
    create.mockResolvedValue({});
    const { result } = renderWorkspace();

    expect(result.current.isReady()).toBe(false);
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.workspace).toMatchObject({
      status: "ready",
      key: "/home/you/projA",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "EvoScientist",
        assistantId: workspaceAssistantId("EvoScientist", "/home/you/projA"),
      })
    );
    expect(assistantIdFor(result.current.workspace, "scheduler")).toBe(
      workspaceAssistantId("scheduler", "/home/you/projA")
    );
  });

  it("addresses graphs by name on a core without the route", async () => {
    stubBackend(() => json(404));
    const { result } = renderWorkspace();

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.workspace.status).toBe("legacy");
    expect(assistantIdFor(result.current.workspace, "EvoScientist")).toBe(
      "EvoScientist"
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves a graph the backend doesn't have without an assistant", async () => {
    stubBackend(() => served("/home/you/projA"));
    create.mockImplementation(async ({ graphId }: { graphId: string }) => {
      if (graphId === "expert-container-async") {
        throw Object.assign(new Error("Graph not found"), { status: 404 });
      }
      return {};
    });
    const { result } = renderWorkspace();

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(
      assistantIdFor(result.current.workspace, "expert-container-async")
    ).toBeNull();
    expect(
      assistantIdFor(result.current.workspace, "EvoScientist")
    ).not.toBeNull();
  });

  it("keeps reading while the backend is down, saying why", async () => {
    let up = false;
    stubBackend(() =>
      up
        ? served("/home/you/projA")
        : Promise.reject(new TypeError("Failed to fetch"))
    );
    create.mockResolvedValue({});
    const { result } = renderWorkspace();

    await waitFor(() =>
      expect(result.current.error).toMatch(/Failed to fetch/)
    );
    expect(result.current.isReady()).toBe(false);
    up = true;

    await waitFor(() => expect(result.current.isReady()).toBe(true), {
      timeout: 3_000,
    });
    expect(result.current.error).toBeNull();
  });

  it("closes at once when a read starts and opens after its answer renders", async () => {
    let folder = "/home/you/projA";
    stubBackend(() => served(folder));
    create.mockResolvedValue({});
    const { result } = renderWorkspace();
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    folder = "/srv/projB";
    let read!: Promise<unknown>;
    act(() => {
      read = result.current.refresh();
      // Before any render: a run in this same tick is refused.
      expect(result.current.isReady()).toBe(false);
    });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      await read;
    });

    expect(result.current.isReady()).toBe(true);
    expect(result.current.workspace).toMatchObject({ key: "/srv/projB" });
  });

  it("publishes the answer of the latest request when reads overlap", async () => {
    let folder = "/home/you/projA";
    stubBackend(() => served(folder));
    create.mockResolvedValue({});
    const { result } = renderWorkspace();
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.refresh();
      // The backend moves while the first read is in flight.
      folder = "/srv/projB";
      second = result.current.refresh();
    });
    await act(async () => {
      await Promise.all([first, second]);
    });

    await expect(first).resolves.toMatchObject({ key: "/srv/projB" });
    expect(result.current.workspace).toMatchObject({ key: "/srv/projB" });
  });

  it("connects under React's development double mount", async () => {
    stubBackend(() => served("/home/you/projA"));
    create.mockResolvedValue({});
    const { result } = renderHook(() => useWorkspace(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceProvider
          deploymentUrl="http://127.0.0.1:6174"
          apiKey=""
        >
          {children}
        </WorkspaceProvider>
      ),
      // Mount, unmount and mount again, as `next dev` does.
      reactStrictMode: true,
    });

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.workspace).toMatchObject({ key: "/home/you/projA" });
  });

  it("starts again on another backend and drops the last one's answer", async () => {
    const folders: Record<string, string> = {
      "http://127.0.0.1:6174": "/home/you/projA",
      "http://127.0.0.1:7000": "/srv/projB",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/workspace/local")) return json(404);
        return served(folders[url.replace("/api/workspace", "")]);
      })
    );
    // projA's assistants hang once asked to, as `assistants.create` takes no
    // abort signal.
    let holdA = false;
    const heldA: Array<() => void> = [];
    create.mockImplementation(
      ({ metadata }: { metadata: { workspace_dir: string } }) =>
        holdA && metadata.workspace_dir === "/home/you/projA"
          ? new Promise((resolve) => heldA.push(() => resolve({})))
          : Promise.resolve({})
    );
    let deploymentUrl = "http://127.0.0.1:6174";
    const { result, rerender } = renderHook(() => useWorkspace(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceProvider
          deploymentUrl={deploymentUrl}
          apiKey=""
        >
          {children}
        </WorkspaceProvider>
      ),
    });
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    holdA = true;
    act(() => {
      void result.current.refresh();
    });
    deploymentUrl = "http://127.0.0.1:7000";
    rerender();
    expect(result.current.workspace.status).toBe("pending");
    expect(result.current.isReady()).toBe(false);
    await waitFor(() =>
      expect(result.current.workspace).toMatchObject({ key: "/srv/projB" })
    );

    // The last backend's read ends late, and changes nothing.
    await act(async () => {
      heldA.forEach((release) => release());
    });
    expect(result.current.workspace).toMatchObject({ key: "/srv/projB" });
    expect(result.current.isReady()).toBe(true);
  });

  it("reads nothing for a refresh kept from before a backend switch", async () => {
    const folders: Record<string, string> = {
      "http://127.0.0.1:6174": "/home/you/projA",
      "http://127.0.0.1:7000": "/srv/projB",
    };
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/workspace/local")) return json(404);
        const base = url.replace("/api/workspace", "");
        reads.push(base);
        return served(folders[base]);
      })
    );
    create.mockResolvedValue({});
    let deploymentUrl = "http://127.0.0.1:6174";
    const { result, rerender } = renderHook(() => useWorkspace(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceProvider
          deploymentUrl={deploymentUrl}
          apiKey=""
        >
          {children}
        </WorkspaceProvider>
      ),
    });
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    const staleRefresh = result.current.refresh;
    deploymentUrl = "http://127.0.0.1:7000";
    rerender();
    await waitFor(() =>
      expect(result.current.workspace).toMatchObject({ key: "/srv/projB" })
    );
    const readsBefore = reads.length;

    // A request made on the old backend fails late and asks to read again.
    await act(async () => {
      await staleRefresh();
    });

    expect(reads).toHaveLength(readsBefore);
    expect(result.current.workspace).toMatchObject({ key: "/srv/projB" });
    expect(result.current.isReady()).toBe(true);
  });

  it("keeps a re-read asked for on the new backend while the old one's read ends", async () => {
    const folders: Record<string, string> = {
      "http://127.0.0.1:6174": "/home/you/projA",
      "http://127.0.0.1:7000": "/srv/projB",
    };
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/workspace/local")) return json(404);
        const base = url.replace("/api/workspace", "");
        reads.push(base);
        return served(folders[base]);
      })
    );
    const held: Record<string, Array<() => void>> = {
      "/home/you/projA": [],
      "/srv/projB": [],
    };
    const holding = new Set<string>();
    create.mockImplementation(
      ({ metadata }: { metadata: { workspace_dir: string } }) =>
        holding.has(metadata.workspace_dir)
          ? new Promise((resolve) =>
              held[metadata.workspace_dir].push(() => resolve({}))
            )
          : Promise.resolve({})
    );
    let deploymentUrl = "http://127.0.0.1:6174";
    const { result, rerender } = renderHook(() => useWorkspace(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceProvider
          deploymentUrl={deploymentUrl}
          apiKey=""
        >
          {children}
        </WorkspaceProvider>
      ),
    });
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    holding.add("/home/you/projA");
    act(() => {
      void result.current.refresh();
    });
    holding.add("/srv/projB");
    deploymentUrl = "http://127.0.0.1:7000";
    rerender();
    await waitFor(() =>
      expect(held["/srv/projB"]).toHaveLength(RUN_GRAPHS.size)
    );
    // Asked for on the new backend, while both reads are in flight.
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      held["/home/you/projA"].forEach((release) => release());
    });
    holding.delete("/srv/projB");
    await act(async () => {
      held["/srv/projB"].forEach((release) => release());
    });

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(reads.filter((url) => url === "http://127.0.0.1:7000")).toHaveLength(
      2
    );
  });

  it("gives scheduled tasks the folder's scheduler, and none while it is read again", async () => {
    stubBackend(() => served("/home/you/projA"));
    create.mockResolvedValue({});
    const { result } = renderHook(
      () => ({ ...useWorkspace(), target: useSchedulerTarget() }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <WorkspaceProvider
            deploymentUrl="http://127.0.0.1:6174"
            apiKey=""
          >
            {children}
          </WorkspaceProvider>
        ),
      }
    );
    await waitFor(() =>
      expect(result.current.target).toEqual({
        assistantId: workspaceAssistantId("scheduler", "/home/you/projA"),
        workspaceDir: "/home/you/projA",
      })
    );

    let read!: Promise<unknown>;
    act(() => {
      read = result.current.refresh();
    });
    expect(result.current.target).toBeNull();
    await act(async () => {
      await read;
    });
    expect(result.current.target).not.toBeNull();
  });

  it("doesn't hold the chat up when the local files check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes("/api/workspace/local")
          ? json(500)
          : served("/home/you/projA")
      )
    );
    create.mockResolvedValue({});
    const { result } = renderWorkspace();

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.workspace).toMatchObject({ local: null });
  });
});
