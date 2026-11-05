// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, DraftList } from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import { autoSkillsReadOnlyReason } from "@/lib/autoskills";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const runsGet = vi.hoisted(() => vi.fn());
const clientBox = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => clientBox.current,
}));

const state = vi.hoisted(() => ({
  status: "ready" as string,
  list: null as unknown,
  // SWR's mutate: resolves with the cached list, even when the read fails.
  refresh: vi.fn(),
  // The direct read the end of a run counts from.
  readNow: vi.fn(),
}));
vi.mock("@/app/hooks/useAutoSkills", () => ({
  useAutoSkills: () => ({
    status: state.status,
    list: state.list,
    refresh: state.refresh,
    readNow: state.readNow,
  }),
}));

import {
  REREAD_WAIT_MS,
  RUN_CEILING_MS,
  RUN_GET_TIMEOUT_MS,
  RUN_POLL_MS,
  useRunNow,
} from "./useRunNow";

const A = "/work/EvoSci_test";
const B = "/work/project_B";
const projects: Project[] = [
  { key: A, name: "EvoSci_test", missing: false },
  { key: B, name: "project_B", missing: false },
];

function draft(
  id: string,
  dir: string,
  status = "pending",
  approvedBy: "user" | "auto" | null = null
): Draft {
  return {
    proposal_id: id,
    status,
    workspace_dir: dir,
    approved_by: approvedBy,
  } as unknown as Draft;
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
  clientBox.current = { runs: { get: runsGet } };
  vi.useFakeTimers();
  toast.success.mockClear();
  toast.error.mockClear();
  toast.info.mockClear();
  runsGet.mockReset();
  state.status = "ready";
  state.list = listOf([draft("old", B)]);
  state.refresh.mockReset();
  state.refresh.mockResolvedValue(listOf([draft("old", B)]));
  state.readNow.mockReset();
  state.readNow.mockResolvedValue(listOf([draft("old", B)]));
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
    // Each poll can be cut short.
    expect(runsGet).toHaveBeenCalledWith("t1", "r1", {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.running.has(B)).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    await tick();
    expect(runsGet).toHaveBeenCalledTimes(2);
    expect(state.readNow).toHaveBeenCalledTimes(1);
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

  it("counts new drafts and automatic installs in that project only", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(
      listOf([
        draft("old", B),
        draft("n1", B),
        draft("n2", B),
        draft("other", A),
        // Approved by the user meanwhile: not the run's.
        draft("done", B, "approved", "user"),
        // Auto mode approves at submission: the run installed it.
        draft("auto1", B, "approved", "auto"),
        draft("auto-other", A, "approved", "auto"),
      ])
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 2 new drafts, 1 skill installed automatically."
    );
  });

  it("a run in auto mode says what it installed", async () => {
    state.list = listOf([
      draft("old", B),
      draft("before", B, "approved", "auto"),
    ]);
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(
      listOf([
        draft("old", B),
        // Approved before the run: not counted again.
        draft("before", B, "approved", "auto"),
        draft("a1", B, "approved", "auto"),
        draft("a2", B, "approved", "auto"),
      ])
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 2 skills installed automatically."
    );
  });

  it("an automatic approval of a draft that was pending counts as installed", async () => {
    state.list = listOf([draft("p", B)]);
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(
      listOf([draft("p", B, "approved", "auto"), draft("n", B)])
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft, 1 skill installed automatically."
    );
  });

  it("says one new draft in the singular", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(listOf([draft("old", B), draft("n1", B)]));
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
    state.readNow.mockResolvedValue("unsupported");
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
    expect(toast.error).toHaveBeenCalledWith(
      autoSkillsReadOnlyReason({ writable: false, reason: "secret_rejected" })
    );
  });

  it("local_secret_required reads as the secret_rejected sentence", async () => {
    stubRelay(403, { error: "local_secret_required" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledWith(
      autoSkillsReadOnlyReason({ writable: false, reason: "secret_rejected" })
    );
  });

  it("a 2xx without ids is the generic failure even with an error field", async () => {
    stubRelay(200, { error: "autoskills_off" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills didn't start in project_B. Try Run now again later."
    );
  });

  it("without a read list at the start, finishing gives no count", async () => {
    state.status = "loading";
    state.list = null;
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(listOf([draft("old", B)]));
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

  it("unmount during a wait settles run() and clears the key", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "running" });
    const { result, unmount } = renderHook(() => useRunNow(projects));
    let settled = false;
    await act(async () => {
      void result.current.run(B).then(() => {
        settled = true;
      });
    });
    await flush();
    await tick();
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(runsGet).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a cleanup frees the keys of a run waiting on the relay, and the old run never touches the new one", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    runsGet.mockResolvedValue({ status: "running" });
    const { result, rerender } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The effect's cleanup and re-run on the same instance (the client
    // changed, as a deployment switch does).
    clientBox.current = { runs: { get: runsGet } };
    rerender();
    expect(result.current.running.size).toBe(0);
    await act(async () => {
      void result.current.run(B);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.running.has(B)).toBe(true);
    // The old request answers: nothing is toasted, the new key stays.
    await act(async () => {
      resolvers[0](
        new Response(JSON.stringify({ error: "autoskills_off" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(result.current.running.has(B)).toBe(true);
  });

  it("unmount while the relay start is in flight toasts nothing", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    const { result, unmount } = renderHook(() => useRunNow(projects));
    let settled = false;
    await act(async () => {
      void result.current.run(B).then(() => {
        settled = true;
      });
    });
    unmount();
    await act(async () => {
      release(
        new Response(JSON.stringify(started), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 2);
    });
    expect(settled).toBe(true);
    expect(runsGet).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
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

  it("stops following a run after 30 minutes and says it still runs", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "running" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_CEILING_MS - RUN_POLL_MS);
    });
    expect(toast.info).not.toHaveBeenCalled();
    expect(result.current.running.has(B)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 2);
    });
    // No fixed id: the text alone.
    expect(toast.info.mock.calls).toEqual([
      [
        "AutoSkills is still running in project_B. The drafts update when it finishes.",
      ],
    ]);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(result.current.running.has(B)).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    const polls = runsGet.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 10);
    });
    expect(runsGet).toHaveBeenCalledTimes(polls);
  });

  it("a poll that never answers counts as a failed one, and three end the run", async () => {
    stubRelay(200, started);
    // The SDK sets no timeout on runs.get.
    runsGet.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS + RUN_GET_TIMEOUT_MS);
    });
    // The hung request was given up on, and the next poll went out.
    const first = runsGet.mock.calls[0][2] as { signal: AbortSignal };
    expect(first.signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    expect(runsGet).toHaveBeenCalledTimes(2);
    expect(result.current.running.has(B)).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        RUN_GET_TIMEOUT_MS + RUN_POLL_MS + RUN_GET_TIMEOUT_MS
      );
    });
    expect(runsGet).toHaveBeenCalledTimes(3);
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills didn't finish in project_B. Try Run now again later."
    );
    expect(result.current.running.has(B)).toBe(false);
  });

  it("a poll that hangs at the end of the 30 minutes still ends at the ceiling", async () => {
    stubRelay(200, started);
    const t0 = Date.now();
    runsGet.mockImplementation(() =>
      Date.now() - t0 < RUN_CEILING_MS - 10_000
        ? Promise.resolve({ status: "running" })
        : new Promise(() => {})
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_CEILING_MS + RUN_GET_TIMEOUT_MS);
    });
    expect(toast.info).toHaveBeenCalledWith(
      "AutoSkills is still running in project_B. The drafts update when it finishes."
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.running.has(B)).toBe(false);
  });

  it("slow but answering polls still reach the ceiling", async () => {
    stubRelay(200, started);
    runsGet.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ status: "running" }),
            RUN_GET_TIMEOUT_MS - 1_000
          )
        )
    );
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_CEILING_MS - RUN_GET_TIMEOUT_MS);
    });
    expect(toast.info).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_GET_TIMEOUT_MS * 2);
    });
    expect(toast.info).toHaveBeenCalledWith(
      "AutoSkills is still running in project_B. The drafts update when it finishes."
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.running.has(B)).toBe(false);
  });

  it("a failed read at the end gives no counts, whatever the cache still holds", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    // SWR's mutate would hand back the list from before the run.
    state.refresh.mockResolvedValue(listOf([draft("old", B)]));
    state.readNow.mockRejectedValue(new Error("HTTP 500"));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B."
    );
    expect(result.current.running.has(B)).toBe(false);
  });

  it("a re-read that never answers doesn't hold the end of a run", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    expect(state.readNow).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REREAD_WAIT_MS);
    });
    // Without the list there is no count, and the read was cut short.
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B."
    );
    const [signal] = state.readNow.mock.calls[0] as [AbortSignal];
    expect(signal.aborted).toBe(true);
    expect(result.current.running.has(B)).toBe(false);
  });

  it("joins a run already going in that project and follows it to the end", async () => {
    stubRelay(409, {
      error: "already_running",
      thread_id: "t9",
      run_id: "r9",
    });
    runsGet
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "success" });
    state.readNow.mockResolvedValue(listOf([draft("old", B), draft("n1", B)]));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    // Said once, with no fixed id.
    expect(toast.info.mock.calls).toEqual([
      ["AutoSkills is already running in project_B."],
    ]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.running.has(B)).toBe(true);
    await tick();
    expect(runsGet).toHaveBeenCalledWith("t9", "r9", {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.running.has(B)).toBe(true);
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(result.current.running.has(B)).toBe(false);
    expect(bodies).toHaveLength(1);
  });

  it("counts a joined run's drafts from the moment it was joined", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          })
      )
    );
    runsGet.mockResolvedValue({ status: "success" });
    const { result, rerender } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    // The list read meanwhile already has the joined run's first draft.
    state.list = listOf([draft("old", B), draft("n0", B)]);
    rerender();
    await act(async () => {
      answer(
        new Response(
          JSON.stringify({
            error: "already_running",
            thread_id: "t9",
            run_id: "r9",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        )
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    state.readNow.mockResolvedValue(
      listOf([draft("old", B), draft("n0", B), draft("n1", B)])
    );
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
  });

  it("already_running without both ids says it didn't start", async () => {
    for (const body of [
      { error: "already_running" },
      { error: "already_running", thread_id: "t9" },
      { error: "already_running", thread_id: "t9", run_id: 5 },
    ]) {
      toast.error.mockClear();
      stubRelay(409, body);
      const { result, unmount } = renderHook(() => useRunNow(projects));
      await act(async () => {
        await result.current.run(B);
      });
      expect(toast.error).toHaveBeenCalledWith(
        "AutoSkills didn't start in project_B. Try Run now again later."
      );
      expect(toast.info).not.toHaveBeenCalled();
      expect(runsGet).not.toHaveBeenCalled();
      expect(result.current.running.size).toBe(0);
      unmount();
    }
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
