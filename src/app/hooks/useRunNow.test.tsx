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

// The settings as the page read them: Run now's refusals are worded by them.
const settings = vi.hoisted(() => ({ payload: undefined as unknown }));
vi.mock("@/app/hooks/useSettings", () => ({
  useSettings: () => ({ payload: settings.payload }),
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
/** A draft with the core's stamps (`YYYY-MM-DDTHH:MM:SSZ`). */
function stamped(
  id: string,
  dir: string,
  over: Partial<
    Pick<Draft, "status" | "created_at" | "approved_at" | "approved_by">
  > = {}
): Draft {
  return {
    proposal_id: id,
    status: "pending",
    workspace_dir: dir,
    created_at: "2026-11-09T03:00:00Z",
    approved_at: null,
    approved_by: null,
    ...over,
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
  settings.payload = {
    settings: { memory_skill_synthesis_enabled: true },
    sources: {},
  };
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

  it("autoskills_off under an override says the variable turns it off", async () => {
    // The page's Settings can't turn it on: an environment variable decides.
    settings.payload = {
      settings: { memory_skill_synthesis_enabled: true },
      sources: {
        memory_skill_synthesis_enabled: { source: "env", shadowed: true },
      },
    };
    stubRelay(409, { error: "autoskills_off" });
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      await result.current.run(B);
    });
    expect(toast.error.mock.calls).toEqual([
      [
        "AutoSkills is off: an environment variable on the machine that runs EvoScientist turns it off.",
      ],
    ]);
    expect(result.current.running.size).toBe(0);
  });

  it("autoskills_off reads the settings as they are when the answer comes", async () => {
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
    const { result, rerender } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    // Read meanwhile: the override shows only now.
    settings.payload = {
      settings: { memory_skill_synthesis_enabled: false },
      sources: {
        memory_skill_synthesis_enabled: { source: "env", shadowed: true },
      },
    };
    rerender();
    await act(async () => {
      answer(
        new Response(JSON.stringify({ error: "autoskills_off" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toast.error).toHaveBeenCalledWith(
      "AutoSkills is off: an environment variable on the machine that runs EvoScientist turns it off."
    );
  });

  it("autoskills_off without settings, or with another field overridden, asks to turn it on", async () => {
    for (const payload of [
      undefined,
      {
        settings: {},
        sources: {
          memory_skill_synthesis_mode: { source: "env", shadowed: true },
          memory_skill_synthesis_enabled: { source: "config", shadowed: false },
        },
      },
    ]) {
      settings.payload = payload;
      toast.error.mockClear();
      stubRelay(409, { error: "autoskills_off" });
      const { result, unmount } = renderHook(() => useRunNow(projects));
      await act(async () => {
        await result.current.run(B);
      });
      expect(toast.error).toHaveBeenCalledWith(
        "AutoSkills is off. Turn it on in Settings first."
      );
      unmount();
    }
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

  it("a run that errors says it didn't finish, and the drafts are read again", async () => {
    for (const status of ["error", "timeout", "interrupted"]) {
      toast.error.mockClear();
      state.refresh.mockClear();
      stubRelay(200, started);
      runsGet.mockResolvedValue({ status });
      const { result, unmount } = renderHook(() => useRunNow(projects));
      await act(async () => {
        void result.current.run(B);
      });
      await flush();
      await tick();
      expect(toast.error.mock.calls, status).toEqual([
        ["AutoSkills didn't finish in project_B. Try Run now again later."],
      ]);
      // It may have written drafts before it failed.
      expect(state.refresh, status).toHaveBeenCalledTimes(1);
      // In the background: not the direct read a finished run counts from.
      expect(state.readNow, status).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(result.current.running.has(B)).toBe(false);
      unmount();
    }
  });

  it("a failed run's re-read that fails or never answers holds nothing", async () => {
    for (const reread of [
      () => Promise.reject(new Error("HTTP 500")),
      () => new Promise(() => {}),
      () => {
        throw new Error("no cache");
      },
    ]) {
      toast.error.mockClear();
      state.refresh.mockReset();
      state.refresh.mockImplementation(reread);
      stubRelay(200, started);
      runsGet.mockResolvedValue({ status: "error" });
      const { result, unmount } = renderHook(() => useRunNow(projects));
      await act(async () => {
        void result.current.run(B);
      });
      await flush();
      await tick();
      expect(toast.error).toHaveBeenCalledWith(
        "AutoSkills didn't finish in project_B. Try Run now again later."
      );
      expect(result.current.running.has(B)).toBe(false);
      unmount();
    }
  });

  it("three failed polls in a row say the page couldn't check, not that the run didn't finish", async () => {
    stubRelay(200, started);
    // The backend can't be reached (a tunnel that dropped); the run goes on.
    runsGet.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useRunNow(projects));
    await act(async () => {
      void result.current.run(B);
    });
    await flush();
    await tick();
    await tick();
    expect(toast.error).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    await tick();
    expect(runsGet).toHaveBeenCalledTimes(3);
    // No fixed id: the text alone.
    expect(toast.error.mock.calls).toEqual([
      [
        "Couldn't check on AutoSkills in project_B. It may still be running; the drafts update when it finishes.",
      ],
    ]);
    // The drafts are read again, in the background.
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.readNow).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(result.current.running.has(B)).toBe(false);
    // The page stops asking; Run now can be clicked again (it joins).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 5);
    });
    expect(runsGet).toHaveBeenCalledTimes(3);
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
      "Couldn't check on AutoSkills in project_B. It may still be running; the drafts update when it finishes."
    );
    expect(state.refresh).toHaveBeenCalledTimes(1);
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

// The end toast counts by time: what the project's drafts say was made at or
// after the run's start (LangGraph's `created_at`, floored to the second, as
// the core's stamps are), not what a list read earlier didn't hold yet.
describe("useRunNow counts by the run's start", () => {
  // LangGraph's stamp: microseconds and +00:00.
  const STARTED = "2026-11-10T09:00:00.654321+00:00";
  const ended = { status: "success", created_at: STARTED };

  async function finish(key = B) {
    const hook = renderHook(() => useRunNow(projects));
    await act(async () => {
      void hook.result.current.run(key);
    });
    await flush();
    await tick();
    return hook;
  }

  it("counts the drafts created and the automatic installs made since, to the second", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue(ended);
    state.list = listOf([stamped("old", B)]);
    state.readNow.mockResolvedValue(
      listOf([
        stamped("old", B),
        // A cron run's, a second before this run: the list read before the
        // run (up to a minute old) didn't hold it yet.
        stamped("cron", B, { created_at: "2026-11-10T08:59:59Z" }),
        // In the run's first second: the core's stamps have no fraction.
        stamped("first", B, { created_at: "2026-11-10T09:00:00Z" }),
        stamped("later", B, { created_at: "2026-11-10T09:03:10Z" }),
        stamped("other", A, { created_at: "2026-11-10T09:01:00Z" }),
        stamped("auto", B, {
          status: "approved",
          approved_by: "auto",
          created_at: "2026-11-10T09:02:00Z",
          approved_at: "2026-11-10T09:02:00Z",
        }),
        stamped("auto-before", B, {
          status: "approved",
          approved_by: "auto",
          approved_at: "2026-11-10T08:00:00Z",
        }),
        // Approved by the user meanwhile: not the run's install.
        stamped("mine", B, {
          status: "approved",
          approved_by: "user",
          created_at: "2026-11-10T09:01:00Z",
          approved_at: "2026-11-10T09:02:30Z",
        }),
        stamped("auto-other", A, {
          status: "approved",
          approved_by: "auto",
          approved_at: "2026-11-10T09:02:00Z",
        }),
        stamped("no", B, {
          status: "rejected",
          created_at: "2026-11-10T09:01:00Z",
        }),
      ])
    );
    await finish();
    expect(toast.success.mock.calls).toEqual([
      [
        "AutoSkills finished in project_B: 2 new drafts, 1 skill installed automatically.",
      ],
    ]);
  });

  it("a joined run counts the drafts it made before the page joined", async () => {
    stubRelay(409, {
      error: "already_running",
      thread_id: "t9",
      run_id: "r9",
    });
    runsGet.mockResolvedValue(ended);
    // Made two minutes into the run, before the join: the list the page
    // holds at the join already has it.
    const early = stamped("n0", B, { created_at: "2026-11-10T09:02:00Z" });
    const autoEarly = stamped("a0", B, {
      status: "approved",
      approved_by: "auto",
      created_at: "2026-11-10T09:01:00Z",
      approved_at: "2026-11-10T09:01:00Z",
    });
    state.list = listOf([stamped("old", B), early, autoEarly]);
    state.readNow.mockResolvedValue(
      listOf([
        stamped("old", B),
        early,
        autoEarly,
        stamped("n1", B, { created_at: "2026-11-10T09:05:00Z" }),
      ])
    );
    await finish();
    expect(toast.success.mock.calls).toEqual([
      [
        "AutoSkills finished in project_B: 2 new drafts, 1 skill installed automatically.",
      ],
    ]);
  });

  it("a pending draft the run resubmitted keeps its created_at and isn't new", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue(ended);
    state.readNow.mockResolvedValue(
      listOf([
        {
          ...stamped("old", B),
          updated_at: "2026-11-10T09:04:00Z",
        } as Draft,
      ])
    );
    await finish();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: no new patterns this time."
    );
  });

  it("an automatic approval of a draft that was pending counts as installed, by when it was approved", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue(ended);
    state.list = listOf([stamped("p", B)]);
    state.readNow.mockResolvedValue(
      listOf([
        stamped("p", B, {
          status: "approved",
          approved_by: "auto",
          approved_at: "2026-11-10T09:04:00Z",
        }),
      ])
    );
    await finish();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 skill installed automatically."
    );
  });

  it("compares instants, whatever the offset the stamps are written in", async () => {
    stubRelay(200, started);
    // 09:00:00Z.
    runsGet.mockResolvedValue({
      status: "success",
      created_at: "2026-11-10T10:00:00.25+01:00",
    });
    state.readNow.mockResolvedValue(
      listOf([
        stamped("before", B, { created_at: "2026-11-10T09:30:00+01:00" }),
        stamped("after", B, { created_at: "2026-11-10T04:00:01-05:00" }),
      ])
    );
    await finish();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
  });

  it("takes the start from the first poll that answers", async () => {
    stubRelay(200, started);
    runsGet
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ status: "running", created_at: STARTED })
      // Not read again: this one names another start.
      .mockResolvedValueOnce({
        status: "success",
        created_at: "2026-11-10T09:10:00+00:00",
      });
    // Made between the two starts, and already in the list the page holds.
    const n = stamped("n", B, { created_at: "2026-11-10T09:05:00Z" });
    state.list = listOf([n]);
    state.readNow.mockResolvedValue(listOf([n]));
    const hook = renderHook(() => useRunNow(projects));
    await act(async () => {
      void hook.result.current.run(B);
    });
    await flush();
    await tick();
    await tick();
    await tick();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
  });

  it("needs no list read before the run", async () => {
    state.status = "loading";
    state.list = null;
    stubRelay(200, started);
    runsGet.mockResolvedValue(ended);
    state.readNow.mockResolvedValue(
      listOf([
        stamped("old", B),
        stamped("n", B, { created_at: "2026-11-10T09:05:00Z" }),
      ])
    );
    await finish();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: 1 new draft."
    );
  });

  it("a draft whose stamp can't be read isn't counted", async () => {
    stubRelay(200, started);
    runsGet.mockResolvedValue(ended);
    state.readNow.mockResolvedValue(
      listOf([
        stamped("blank", B, { created_at: "" }),
        stamped("odd", B, { created_at: "today" }),
        stamped("auto", B, {
          status: "approved",
          approved_by: "auto",
          approved_at: null,
        }),
      ])
    );
    await finish();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B: no new patterns this time."
    );
  });

  it("a start that can't be read falls back to what the list held before the run", async () => {
    for (const created_at of [
      undefined,
      null,
      5,
      "",
      "soon",
      // No zone: not an instant.
      "2026-11-10T09:00:00",
      "2026-11-10 09:00:00+00:00",
    ]) {
      toast.success.mockClear();
      stubRelay(200, started);
      runsGet.mockResolvedValue({ status: "success", created_at });
      state.list = listOf([stamped("old", B)]);
      state.readNow.mockResolvedValue(
        // Not in the list before the run, whatever its stamp says.
        listOf([stamped("old", B), stamped("n", B)])
      );
      const { unmount } = await finish();
      expect(toast.success.mock.calls, String(created_at)).toEqual([
        ["AutoSkills finished in project_B: 1 new draft."],
      ]);
      unmount();
    }
  });

  it("without a start and without a list before the run there is no count", async () => {
    state.status = "loading";
    state.list = null;
    stubRelay(200, started);
    runsGet.mockResolvedValue({ status: "success" });
    state.readNow.mockResolvedValue(listOf([stamped("n", B)]));
    await finish();
    expect(toast.success).toHaveBeenCalledWith(
      "AutoSkills finished in project_B."
    );
  });
});
