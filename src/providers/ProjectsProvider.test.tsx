// @vitest-environment jsdom
//
// The WebUI asks the backend which projects it serves before anything runs,
// keeps a current project, and shows files only when the page's backend is
// this machine's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { ProjectsProvider, useProjects } from "./ProjectsProvider";
import { readLastUsedProject, writeLastUsedProject } from "@/lib/projects";

const A = "http://127.0.0.1:6174";
const B = "http://127.0.0.1:7000";

function json(status: number, body: unknown = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

const listing = (...keys: string[]) =>
  json(200, {
    workspaces: keys.map((key) => ({
      workspace_dir: key,
      name: key.split("/").at(-1),
      missing: false,
    })),
  });

interface Backend {
  /** The answer to `GET /api/workspaces`. */
  projects: () => Promise<Response>;
  /** Its `GET /api/instance`. */
  instance?: string | null;
  /** Its `GET /api/instance` read itself, when a test drives it. */
  instanceRead?: (init?: RequestInit) => Promise<Response>;
}

/**
 * Backends by deployment URL, and this machine's file routes, whose backend
 * reports `local` (the first backend's instance by default).
 */
function stubBackends(
  backends: Record<string, Backend>,
  local: string | null | ((init?: RequestInit) => Promise<Response>) = "inst-A"
) {
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workspace/instance") {
        return typeof local === "function"
          ? local(init)
          : json(200, { instance: local });
      }
      const base = Object.keys(backends).find((b) => url.startsWith(b));
      if (!base) return json(404);
      if (url.endsWith("/api/instance")) {
        const read = backends[base].instanceRead;
        return read
          ? read(init)
          : json(200, { instance: backends[base].instance ?? null });
      }
      reads.push(base);
      return backends[base].projects();
    })
  );
  return reads;
}

function wrapperFor(url: () => string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ProjectsProvider
        deploymentUrl={url()}
        apiKey=""
      >
        {children}
      </ProjectsProvider>
    );
  };
}

function renderProjects(url = A) {
  return renderHook(() => useProjects(), { wrapper: wrapperFor(() => url) });
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("ProjectsProvider", () => {
  it("opens once the projects are in, by name, the first one current", async () => {
    stubBackends({
      [A]: { projects: () => listing("/srv/zeta", "/home/you/alpha") },
    });
    const { result } = renderProjects();

    expect(result.current.isReady()).toBe(false);
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.projects).toMatchObject({
      status: "ready",
      projects: [{ key: "/home/you/alpha" }, { key: "/srv/zeta" }],
    });
    expect(result.current.current?.key).toBe("/home/you/alpha");
  });

  it("says a core without the project list is unsupported", async () => {
    stubBackends({ [A]: { projects: () => json(404) } });
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.projects.status).toBe("unsupported");
    expect(result.current.current).toBeNull();
  });

  it("keeps reading while the backend is down, saying why", async () => {
    let up = false;
    stubBackends({
      [A]: {
        projects: () =>
          up
            ? listing("/home/you/projA")
            : Promise.reject(new TypeError("Failed to fetch")),
      },
    });
    const { result } = renderProjects();

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
    let keys = ["/home/you/projA"];
    stubBackends({ [A]: { projects: () => listing(...keys) } });
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    keys = ["/srv/projB"];
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
    expect(result.current.current?.key).toBe("/srv/projB");
  });

  it("publishes the answer of the latest request when reads overlap", async () => {
    let keys = ["/home/you/projA"];
    stubBackends({ [A]: { projects: () => listing(...keys) } });
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.refresh();
      // A project is removed while the first read is in flight.
      keys = ["/srv/projB"];
      second = result.current.refresh();
    });
    await act(async () => {
      await Promise.all([first, second]);
    });

    await expect(first).resolves.toMatchObject({
      projects: [{ key: "/srv/projB" }],
    });
    expect(result.current.current?.key).toBe("/srv/projB");
  });

  it("connects under React's development double mount", async () => {
    stubBackends({ [A]: { projects: () => listing("/home/you/projA") } });
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapperFor(() => A),
      // Mount, unmount and mount again, as `next dev` does.
      reactStrictMode: true,
    });

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.current?.key).toBe("/home/you/projA");
  });

  it("starts again on another backend and drops the last one's answer", async () => {
    let holdA = false;
    const heldA: Array<() => void> = [];
    stubBackends({
      [A]: {
        projects: () =>
          holdA
            ? new Promise<Response>((resolve) =>
                heldA.push(() => void listing("/home/you/projA").then(resolve))
              )
            : listing("/home/you/projA"),
      },
      [B]: { projects: () => listing("/srv/projB") },
    });
    let url = A;
    const { result, rerender } = renderHook(() => useProjects(), {
      wrapper: wrapperFor(() => url),
    });
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    holdA = true;
    act(() => {
      void result.current.refresh();
    });
    url = B;
    rerender();
    expect(result.current.projects.status).toBe("pending");
    expect(result.current.isReady()).toBe(false);
    await waitFor(() => expect(result.current.current?.key).toBe("/srv/projB"));

    // The last backend's read ends late, and changes nothing.
    await act(async () => {
      heldA.forEach((release) => release());
    });
    expect(result.current.current?.key).toBe("/srv/projB");
    expect(result.current.isReady()).toBe(true);
  });

  it("reads nothing for a refresh kept from before a backend switch", async () => {
    const reads = stubBackends({
      [A]: { projects: () => listing("/home/you/projA") },
      [B]: { projects: () => listing("/srv/projB") },
    });
    let url = A;
    const { result, rerender } = renderHook(() => useProjects(), {
      wrapper: wrapperFor(() => url),
    });
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    const staleRefresh = result.current.refresh;
    url = B;
    rerender();
    await waitFor(() => expect(result.current.current?.key).toBe("/srv/projB"));
    const readsBefore = reads.length;

    // A request made on the old backend fails late and asks to read again.
    await act(async () => {
      await staleRefresh();
    });

    expect(reads).toHaveLength(readsBefore);
    expect(result.current.current?.key).toBe("/srv/projB");
    expect(result.current.isReady()).toBe(true);
  });

  it("keeps a re-read asked for on the new backend while the old one's read ends", async () => {
    const held: Record<string, Array<() => void>> = { [A]: [], [B]: [] };
    const holding = new Set<string>();
    const answer = (base: string, key: string) => () =>
      holding.has(base)
        ? new Promise<Response>((resolve) =>
            held[base].push(() => void listing(key).then(resolve))
          )
        : listing(key);
    const reads = stubBackends({
      [A]: { projects: answer(A, "/home/you/projA") },
      [B]: { projects: answer(B, "/srv/projB") },
    });
    let url = A;
    const { result, rerender } = renderHook(() => useProjects(), {
      wrapper: wrapperFor(() => url),
    });
    await waitFor(() => expect(result.current.isReady()).toBe(true));

    holding.add(A);
    act(() => {
      void result.current.refresh();
    });
    holding.add(B);
    url = B;
    rerender();
    await waitFor(() => expect(held[B]).toHaveLength(1));
    // Asked for on the new backend, while both reads are in flight.
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      held[A].forEach((release) => release());
    });
    holding.delete(B);
    await act(async () => {
      held[B].forEach((release) => release());
    });

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(reads.filter((base) => base === B)).toHaveLength(2);
  });
});

describe("ProjectsProvider current project", () => {
  it("starts in the project last used on this backend", async () => {
    stubBackends({
      [A]: { projects: () => listing("/home/you/alpha", "/srv/beta") },
    });
    const first = renderProjects();
    await waitFor(() => expect(first.result.current.isReady()).toBe(true));
    act(() =>
      first.result.current.selectProject("/srv/beta", { remember: true })
    );
    expect(first.result.current.current?.key).toBe("/srv/beta");
    first.unmount();

    const again = renderProjects();
    await waitFor(() => expect(again.result.current.isReady()).toBe(true));
    expect(again.result.current.current?.key).toBe("/srv/beta");
  });

  it("follows a selected project without making it the last used", async () => {
    stubBackends({
      [A]: { projects: () => listing("/home/you/alpha", "/srv/beta") },
    });
    const first = renderProjects();
    await waitFor(() => expect(first.result.current.isReady()).toBe(true));
    act(() => first.result.current.selectProject("/srv/beta"));
    expect(first.result.current.current?.key).toBe("/srv/beta");
    first.unmount();

    const again = renderProjects();
    await waitFor(() => expect(again.result.current.isReady()).toBe(true));
    expect(again.result.current.current?.key).toBe("/home/you/alpha");
  });

  it("skips a project that is no longer registered or whose folder is missing", async () => {
    let rows = [
      { workspace_dir: "/home/you/alpha", name: "alpha", missing: false },
      { workspace_dir: "/srv/beta", name: "beta", missing: false },
    ];
    stubBackends({
      [A]: { projects: () => json(200, { workspaces: rows }) },
    });
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    act(() => result.current.selectProject("/srv/beta", { remember: true }));

    rows = [
      { workspace_dir: "/home/you/alpha", name: "alpha", missing: false },
      { workspace_dir: "/srv/beta", name: "beta", missing: true },
    ];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.current?.key).toBe("/home/you/alpha");

    rows = [{ workspace_dir: "/srv/beta", name: "beta", missing: true }];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.current).toBeNull();
  });
});

describe("ProjectsProvider removed projects", () => {
  const alpha = {
    workspace_dir: "/home/you/alpha",
    name: "alpha",
    missing: false,
  };
  const beta = { workspace_dir: "/srv/beta", name: "beta", missing: false };

  it("forgets a removed project, so adding it again doesn't make it current", async () => {
    let rows = [alpha, beta];
    stubBackends({
      [A]: { projects: () => json(200, { workspaces: rows }) },
    });
    const first = renderProjects();
    await waitFor(() => expect(first.result.current.isReady()).toBe(true));
    act(() =>
      first.result.current.selectProject("/srv/beta", { remember: true })
    );

    rows = [alpha];
    await act(async () => {
      await first.result.current.refresh();
    });
    rows = [alpha, beta];
    await act(async () => {
      await first.result.current.refresh();
    });

    expect(first.result.current.current?.key).toBe("/home/you/alpha");
    first.unmount();
    const again = renderProjects();
    await waitFor(() => expect(again.result.current.isReady()).toBe(true));
    expect(again.result.current.current?.key).toBe("/home/you/alpha");
  });

  it("forgets a removed project that was only selected", async () => {
    let rows = [alpha, beta];
    stubBackends({
      [A]: { projects: () => json(200, { workspaces: rows }) },
    });
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    act(() => result.current.selectProject("/srv/beta"));

    rows = [alpha];
    await act(async () => {
      await result.current.refresh();
    });
    rows = [alpha, beta];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.current?.key).toBe("/home/you/alpha");
  });

  it("keeps a project another tab just picked, which this list doesn't have yet", async () => {
    let rows = [alpha, beta];
    stubBackends({
      [A]: { projects: () => json(200, { workspaces: rows }) },
    });
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    act(() => result.current.selectProject("/srv/beta", { remember: true }));

    // Another tab picks a project; this tab's next list drops its own.
    writeLastUsedProject(A, "/srv/new");
    rows = [alpha];
    await act(async () => {
      await result.current.refresh();
    });

    expect(readLastUsedProject(A)).toBe("/srv/new");
    expect(result.current.current?.key).toBe("/home/you/alpha");
  });

  it("keeps a project whose folder is missing for when it is back", async () => {
    let rows = [alpha, beta];
    stubBackends({
      [A]: { projects: () => json(200, { workspaces: rows }) },
    });
    const { result } = renderProjects();
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    act(() => result.current.selectProject("/srv/beta", { remember: true }));

    rows = [alpha, { ...beta, missing: true }];
    await act(async () => {
      await result.current.refresh();
    });
    rows = [alpha, beta];
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.current?.key).toBe("/srv/beta");
  });
});

/** A read that ends only when its request is aborted, as fetch does. */
function hanging(init?: RequestInit) {
  return new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("Aborted", "AbortError"))
    )
  );
}

describe("ProjectsProvider files", () => {
  const projA = () => listing("/home/you/projA");

  it("shows files when the page's backend is this machine's", async () => {
    stubBackends({ [A]: { projects: projA, instance: "inst-A" } });
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.files).toBe("here"));
  });

  it("shows none for another machine's backend, even with a project at the same path", async () => {
    stubBackends({ [A]: { projects: projA, instance: "inst-elsewhere" } });
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.files).toBe("elsewhere"));
  });

  it.each([
    ["answers no instance", () => json(200, { instance: null })],
    ["has no instance route", () => json(404)],
    [
      "answers something that isn't JSON",
      () => Promise.resolve(new Response("<html></html>", { status: 200 })),
    ],
  ])(
    "shows none, at once, when the page's backend %s",
    async (_, instanceRead) => {
      let localReads = 0;
      stubBackends({ [A]: { projects: projA, instanceRead } }, () => {
        localReads += 1;
        return json(200, { instance: null });
      });
      const { result } = renderProjects();

      await waitFor(() => expect(result.current.files).toBe("elsewhere"));
      expect(localReads).toBe(0);
    }
  );

  it("shows none when no backend has run on this machine", async () => {
    stubBackends({ [A]: { projects: projA, instance: "inst-A" } }, null);
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.files).toBe("elsewhere"));
  });

  it("asks again when the page's backend is busy", async () => {
    let busy = true;
    stubBackends({
      [A]: {
        projects: projA,
        instanceRead: () => {
          if (!busy) return json(200, { instance: "inst-A" });
          busy = false;
          return json(429);
        },
      },
    });
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.files).toBe("here"), {
      timeout: 3_000,
    });
  });

  it("doesn't hold the project list up while this machine's check hangs", async () => {
    stubBackends({ [A]: { projects: projA, instance: "inst-A" } }, hanging);
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.projects.status).toBe("ready");
    expect(result.current.files).toBe("pending");
  });

  it("stays pending while reads fail, and shows files once one answers", async () => {
    let fail = true;
    let localReads = 0;
    stubBackends({ [A]: { projects: projA, instance: "inst-A" } }, () => {
      localReads += 1;
      return fail ? json(502) : json(200, { instance: "inst-A" });
    });
    const { result } = renderProjects();
    await waitFor(() => expect(localReads).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isReady()).toBe(true));
    expect(result.current.files).toBe("pending");

    fail = false;

    await waitFor(() => expect(result.current.files).toBe("here"), {
      timeout: 3_000,
    });
  });

  it("gives up on a read that hangs and asks again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let hang = true;
      let localReads = 0;
      stubBackends({ [A]: { projects: projA, instance: "inst-A" } }, (init) => {
        localReads += 1;
        return hang ? hanging(init) : json(200, { instance: "inst-A" });
      });
      const { result } = renderProjects();
      await waitFor(() => expect(result.current.isReady()).toBe(true));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_100);
      });
      expect(result.current.files).toBe("pending");
      hang = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await waitFor(() => expect(result.current.files).toBe("here"));
      expect(localReads).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again when an answer's body is cut short", async () => {
    let cut = true;
    stubBackends({ [A]: { projects: projA, instance: "inst-A" } }, () => {
      if (!cut) return json(200, { instance: "inst-A" });
      cut = false;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new DOMException("Aborted", "AbortError")),
      } as Response);
    });
    const { result } = renderProjects();

    await waitFor(() => expect(result.current.files).toBe("here"), {
      timeout: 3_000,
    });
  });
});
