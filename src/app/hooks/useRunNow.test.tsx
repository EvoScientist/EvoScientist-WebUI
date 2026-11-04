// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import type { Project } from "@/lib/projects";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const runsGet = vi.hoisted(() => vi.fn());
vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ runs: { get: runsGet } }),
}));

const state = vi.hoisted(() => ({
  list: null as unknown,
  refresh: vi.fn(),
}));
vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({
    status: "ready",
    list: state.list,
    refresh: state.refresh,
  }),
}));

import { RUN_POLL_MS, useRunNow } from "./useRunNow";

const A = "/work/EvoSci_test";
const B = "/work/project_B";
const projects: Project[] = [
  { key: A, name: "EvoSci_test", missing: false },
  { key: B, name: "project_B", missing: false },
];

function draft(id: string, dir: string, status = "pending"): Draft {
  return { proposal_id: id, status, workspace_dir: dir } as unknown as Draft;
}
function listOf(drafts: Draft[]): DraftList {
  return { drafts, counts: {}, byProject: {} } as unknown as DraftList;
}

let bodies: Array<Record<string, unknown>>;
function stubRelay(status: number, body: Record<string, unknown>) {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );
    })
  );
}
const started = { thread_id: "t1", run_id: "r1" };

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  toast.success.mockClear();
  toast.error.mockClear();
  runsGet.mockReset();
  state.list = listOf([draft("old", B)]);
  state.refresh.mockReset();
  state.refresh.mockResolvedValue(listOf([draft("old", B)]));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRunNow", () => {
  it("starts a run through the relay and polls it to the end", async () => {
    stubRelay(200, started);
    runsGet
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "success" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    expect(bodies).toEqual([{ action: "run", workspace_dir: B }]);
    expect(result.current.running.has(B)).toBe(true);
    await tick();
    expect(runsGet).toHaveBeenCalledWith("t1", "r1");
    expect(result.current.running.has(B)).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    await tick();
    expect(runsGet).toHaveBeenCalledTimes(2);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(result.current.running.has(B)).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("ignores a second run of a project that is running", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "running" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
      void result.current.run(B);
    });
    await flush();
    expect(bodies).toHaveLength(1);
  });

  it("counts new drafts in that project only", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.refresh.mockResolvedValue(
      listOf([
        draft("old", B),
        draft("n1", B),
        draft("n2", B),
        draft("other", A),
        draft("done", B, "approved"),
      ])
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 2 new drafts."
    );
  });

  it("says one new draft in the singular", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.refresh.mockResolvedValue(listOf([draft("old", B), draft("n1", B)]));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
  });

  it("says so when nothing new was drafted", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: no new patterns this time."
    );
  });

  it("reports a finished run without a count when the re-read gives no list", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.refresh.mockResolvedValue("unsupported");
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B."
    );
  });

  it("autoskills_off asks to turn it on", async () => {
    stubRelay(409, { error: "autoskills_off" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills is off. Turn it on in Settings first."
    );
    expect(runsGet).not.toHaveBeenCalled();
    expect(result.current.running.size).toBe(0);
  });

  it("not_served names the project", async () => {
    stubRelay(404, { error: "not_served" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "project_B isn't served by this backend right now."
    );
  });

  it.each([
    [400, { error: "invalid_path" }],
    [502, { error: "run_failed", detail: "boom" }],
    [200, { thread_id: "t1" }],
  ])("a start that fails (%s) says it didn't start", async (status, body) => {
    stubRelay(status, body);
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills didn't start in project_B. Try Run now again later."
    );
  });

  it("a network failure says it didn't start", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("x")))
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills didn't start in project_B. Try Run now again later."
    );
  });

  it("a relay refusal reads as the settings reason", async () => {
    stubRelay(403, { error: "secret_rejected" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const text = toast.error.mock.calls[0][0] as string;
    expect(text).not.toMatch(/didn't start/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("a run that errors says it didn't finish", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "error" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills didn't finish in project_B. Try Run now again later."
    );
    expect(result.current.running.has(B)).toBe(false);
  });

  it("three failed polls in a row end it as not finished", async () => {
    stubRelay(200, started);
    runsGet.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    await tick();
    expect(toast.error).not.toHaveBeenCalled();
    await tick();
    expect(runsGet).toHaveBeenCalledTimes(3);
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills didn't finish in project_B. Try Run now again later."
    );
  });

  it("a good poll resets the failure count", async () => {
    stubRelay(200, started);
    runsGet
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ status: "running" })
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce({ status: "success" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    for (let i = 0; i < 6; i++) await tick();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("different projects may run at once", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "running" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(A);
      void result.current.run(B);
    });
    await flush();
    expect(result.current.running.has(A)).toBe(true);
    expect(result.current.running.has(B)).toBe(true);
  });

  it("stops polling on unmount", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "running" });
    const { result, unmount } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(runsGet).toHaveBeenCalledTimes(1);
    unmount();
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 5);
    expect(runsGet).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
