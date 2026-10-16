// @vitest-environment jsdom
//
// The WebUI asks the backend which folder it serves, and nothing runs until
// it knows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const create = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());
// One client per backend, as ClientProvider memoizes it.
const clients = vi.hoisted(() => ({
  current: { assistants: { create, search } } as unknown,
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => clients.current,
}));

import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";

function json(status: number, body: unknown = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function stubBackend(
  route: (url: string) => Promise<Response> | Promise<never>
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => route(String(input)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let deploymentUrl = "http://127.0.0.1:6174";

function renderWorkspace() {
  return renderHook(() => useWorkspace(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <WorkspaceProvider
        deploymentUrl={deploymentUrl}
        apiKey=""
      >
        {children}
      </WorkspaceProvider>
    ),
  });
}

const served = (key: string) =>
  json(200, { workspace_dir: key, run_dir: null });

afterEach(() => {
  deploymentUrl = "http://127.0.0.1:6174";
  clients.current = { assistants: { create, search } };
  vi.unstubAllGlobals();
  vi.useRealTimers();
  create.mockReset();
  search.mockReset();
});

describe("WorkspaceProvider", () => {
  it("serves the backend's folder and creates its assistants under it", async () => {
    stubBackend((url) =>
      url.endsWith("/api/workspace")
        ? json(200, { workspace_dir: "/home/you/projA", run_dir: null })
        : json(200, { dir: "/home/you/projA", sameFolder: true })
    );
    create.mockResolvedValue({ assistant_id: "a-1" });
    const { result } = renderWorkspace();

    expect(result.current.workspace.status).toBe("pending");
    await waitFor(() => expect(result.current.workspace.status).toBe("ready"));
    expect(result.current.workspace).toEqual({
      status: "ready",
      key: "/home/you/projA",
      runDir: null,
      local: { dir: "/home/you/projA", sameFolder: true },
    });

    await result.current.assistantFor("EvoScientist");
    await result.current.assistantFor("EvoScientist");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      graphId: "EvoScientist",
      metadata: { workspace_dir: "/home/you/projA" },
    });
  });

  it("ensures the assistants again after a refresh", async () => {
    stubBackend((url) =>
      url.endsWith("/api/workspace")
        ? json(200, { workspace_dir: "/home/you/projA", run_dir: null })
        : json(404)
    );
    create.mockResolvedValue({ assistant_id: "a-1" });
    const { result } = renderWorkspace();
    await waitFor(() => expect(result.current.workspace.status).toBe("ready"));
    await waitFor(() => expect(result.current.chat.assistant).not.toBeNull());
    const before = create.mock.calls.length;

    // The backend restarted in the same folder with an empty store.
    await act(async () => {
      await result.current.refresh();
    });
    await result.current.assistantFor("EvoScientist");

    expect(create.mock.calls.length).toBeGreaterThan(before);
  });

  it("addresses graphs as before on a core without the route", async () => {
    stubBackend(() => json(404));
    search.mockResolvedValue([
      { assistant_id: "other", metadata: {} },
      { assistant_id: "system", metadata: { created_by: "system" } },
    ]);
    const { result } = renderWorkspace();

    await waitFor(() => expect(result.current.workspace.status).toBe("legacy"));
    await expect(
      result.current.assistantFor("EvoScientist")
    ).resolves.toMatchObject({ assistant_id: "system" });
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps asking while the backend is down", async () => {
    let up = false;
    stubBackend((url) => {
      if (!up) return Promise.reject(new TypeError("Failed to fetch"));
      return url.endsWith("/api/workspace")
        ? json(200, { workspace_dir: "/home/you/projA", run_dir: null })
        : json(404);
    });
    const { result } = renderWorkspace();

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.workspace.status).toBe("pending");
    up = true;

    await waitFor(() => expect(result.current.workspace.status).toBe("ready"), {
      timeout: 3_000,
    });
    expect(result.current.workspace).toMatchObject({ local: null });
  });

  it("forgets the old backend's folder in the render that switches backends", async () => {
    stubBackend((url) =>
      url.startsWith("http://127.0.0.1:6174")
        ? served("/home/you/projA")
        : url.includes("/api/workspace/local")
        ? json(404)
        : served("/srv/projB")
    );
    create.mockResolvedValue({ assistant_id: "a-1" });
    const { result, rerender } = renderWorkspace();
    await waitFor(() => expect(result.current.chat.assistant).not.toBeNull());

    const otherCreate = vi.fn().mockResolvedValue({ assistant_id: "b-1" });
    clients.current = { assistants: { create: otherCreate, search } };
    deploymentUrl = "http://10.0.0.5:6174";
    rerender();

    expect(result.current.workspace.status).toBe("pending");
    await waitFor(() =>
      expect(result.current.workspace).toMatchObject({ key: "/srv/projB" })
    );
    await waitFor(() => expect(otherCreate).toHaveBeenCalled());
    for (const [payload] of otherCreate.mock.calls) {
      expect(payload.metadata).toEqual({ workspace_dir: "/srv/projB" });
    }
  });

  it("answers a refresh that a newer one took over with the newer result", async () => {
    let answer: () => Promise<Response> = () => served("/home/you/projA");
    stubBackend((url) =>
      url.includes("/api/workspace/local") ? json(404) : answer()
    );
    create.mockResolvedValue({ assistant_id: "a-1" });
    const { result } = renderWorkspace();
    await waitFor(() => expect(result.current.workspace.status).toBe("ready"));

    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.refresh();
    });
    answer = () => served("/srv/projB");
    await act(async () => {
      await result.current.refresh();
    });

    await expect(first).resolves.toMatchObject({ key: "/srv/projB" });
  });

  it("blocks runs from the moment a refresh starts until its answer", async () => {
    let answer = () => served("/home/you/projA");
    stubBackend((url) =>
      url.includes("/api/workspace/local") ? json(404) : answer()
    );
    create.mockResolvedValue({ assistant_id: "a-1" });
    const { result } = renderWorkspace();
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    answer = () => served("/srv/projB");
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.refresh();
      // Before any render: a send in this same tick is blocked.
      expect(result.current.isReady()).toBe(false);
    });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      await pending;
    });

    expect(result.current.isReady()).toBe(true);
    expect(result.current.refreshing).toBe(false);
  });

  it("never pairs an assistant with a newer folder answer", async () => {
    let answer = () => served("/home/you/projA");
    stubBackend((url) =>
      url.includes("/api/workspace/local") ? json(404) : answer()
    );
    create.mockImplementation(
      async (payload: { metadata: { workspace_dir: string } }) => ({
        assistant_id: `for ${payload.metadata.workspace_dir}`,
      })
    );
    const seen: Array<[string, string | undefined]> = [];
    const { result } = renderHook(
      () => {
        const value = useWorkspace();
        if (value.workspace.status === "ready") {
          seen.push([value.workspace.key, value.chat.assistant?.assistant_id]);
        }
        return value;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <WorkspaceProvider
            deploymentUrl={deploymentUrl}
            apiKey=""
          >
            {children}
          </WorkspaceProvider>
        ),
      }
    );
    await waitFor(() => expect(result.current.chat.assistant).not.toBeNull());

    answer = () => served("/srv/projB");
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() =>
      expect(result.current.chat.assistant?.assistant_id).toBe("for /srv/projB")
    );

    for (const [key, assistantId] of seen) {
      if (assistantId) expect(assistantId).toBe(`for ${key}`);
    }
  });
});
