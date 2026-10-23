import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_POLL_MS,
  checkWork,
  confirmation,
  hasWork,
  isBackgroundThread,
  waitForMemoryWorkers,
  type Request,
} from "./closeCheck";

const thread = (run_kind?: string) => ({
  thread_id: "t",
  metadata: run_kind ? { run_kind } : {},
});
const cron = (run_kind: string, enabled = true) => ({
  cron_id: "c",
  enabled,
  metadata: { run_kind },
});

function backend(answers: {
  threads?: unknown;
  jobs?: unknown;
  crons?: unknown[][];
  fail?: string;
}): Request & { calls: { path: string; body?: unknown }[] } {
  const calls: { path: string; body?: unknown }[] = [];
  const req = (async (path: string, opts: { body?: unknown }) => {
    calls.push({ path, body: opts.body });
    if (answers.fail && path.includes(answers.fail)) throw new Error("timeout");
    if (path === "/threads/search")
      return { status: 200, body: answers.threads ?? [] };
    if (path === "/api/bg_processes/running")
      return { status: 200, body: answers.jobs ?? { running: [] } };
    const offset = (opts.body as { offset: number }).offset;
    return { status: 200, body: answers.crons?.[offset / 100] ?? [] };
  }) as Request;
  return Object.assign(req, { calls });
}

describe("isBackgroundThread", () => {
  it.each([
    ["evomemory_turn_worker", "memory"],
    ["evomemory_observation_linker", "memory"],
    ["evomemory_autoskills", "memory"],
    ["proactive_check", "proactive"],
    ["scheduled_task", null],
    [undefined, null],
  ])("%s is %s", (kind, expected) => {
    expect(isBackgroundThread(kind)).toBe(expected);
  });
});

describe("checkWork", () => {
  it("is idle with only memory workers and the proactive check busy", async () => {
    const r = await checkWork(
      backend({
        threads: [thread("evomemory_turn_worker"), thread("proactive_check")],
        crons: [[cron("evomemory_autoskills")]],
      })
    );
    expect(r).toEqual({
      kind: "known",
      busyThreads: 0,
      jobs: [],
      scheduledTasks: 0,
    });
    expect(hasWork(r)).toBe(false);
  });

  it("names running jobs and counts busy chats and enabled scheduled tasks", async () => {
    const req = backend({
      threads: [
        thread(),
        thread("evomemory_subagent_worker"),
        thread("something_else"),
      ],
      jobs: {
        running: [{ process_id: "p1", name: "train.py" }, { process_id: "p2" }],
      },
      crons: [[cron("scheduled_task"), cron("scheduled_task", false)]],
    });
    const r = await checkWork(req);
    expect(r).toEqual({
      kind: "known",
      busyThreads: 2,
      jobs: ["train.py", "p2"],
      scheduledTasks: 1,
    });
    expect(
      req.calls.find((c) => c.path === "/runs/crons/search")?.body
    ).toMatchObject({
      enabled: true,
      metadata: { run_kind: "scheduled_task" },
    });
    expect(req.calls.find((c) => c.path === "/threads/search")?.body).toEqual({
      status: "busy",
      limit: 100,
    });
  });

  it("reads every page of crons", async () => {
    const full = Array.from({ length: 100 }, () => cron("scheduled_task"));
    const r = await checkWork(
      backend({ crons: [full, [cron("scheduled_task")]] })
    );
    expect(r).toMatchObject({ scheduledTasks: 101 });
  });

  it("is unknown when any probe fails, and unknown counts as work", async () => {
    const r = await checkWork(backend({ fail: "bg_processes" }));
    expect(r).toEqual({ kind: "unknown", reason: "timeout" });
    expect(hasWork(r)).toBe(true);
  });
});

describe("waitForMemoryWorkers", () => {
  function clock() {
    let t = 0;
    return { now: () => t, pause: vi.fn(async (ms: number) => void (t += ms)) };
  }

  it("waits out the gap before the observation linker starts", async () => {
    // worker busy, then idle for 1 s (the gap), then the linker, then idle.
    const seq = [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    let i = 0;
    const req = (async () => ({
      status: 200,
      body: seq[Math.min(i++, seq.length - 1)]
        ? [thread("evomemory_observation_linker")]
        : [],
    })) as Request;
    const c = clock();
    expect(
      await waitForMemoryWorkers(req, { cancelled: () => false, ...c })
    ).toBe("quiet");
    // Quiet only counts from the last busy poll (index 4), plus 3 s.
    expect(c.now()).toBe((5 + 6) * MEMORY_POLL_MS);
  });

  it("gives up after 120 s, on an unreachable backend, and when cancelled", async () => {
    const busy = (async () => ({
      status: 200,
      body: [thread("evomemory_turn_worker")],
    })) as Request;
    expect(
      await waitForMemoryWorkers(busy, { cancelled: () => false, ...clock() })
    ).toBe("timeout");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as Request;
    expect(
      await waitForMemoryWorkers(down, { cancelled: () => false, ...clock() })
    ).toBe("unreachable");
    expect(
      await waitForMemoryWorkers(busy, { cancelled: () => true, ...clock() })
    ).toBe("cancelled");
  });
});

describe("confirmation", () => {
  const idle = {
    kind: "known" as const,
    busyThreads: 0,
    jobs: [],
    scheduledTasks: 0,
  };

  it("asks nothing when idle", () => {
    expect(confirmation(idle, "quit")).toBeNull();
  });

  it("names the jobs, with Cancel as the default", () => {
    const c = confirmation(
      { ...idle, busyThreads: 1, jobs: ["train.py"] },
      "quit"
    )!;
    expect(c.message).toBe("Work is still running.");
    expect(c.detail).toContain("1 chat is still running.");
    expect(c.detail).toContain("Background jobs running: train.py.");
    expect(c.buttons).toEqual(["Quit", "Cancel"]);
    expect(c.defaultId).toBe(1);
  });

  it("says scheduled tasks will not run while closed, or pause until the backend is back", () => {
    const tasks = { ...idle, scheduledTasks: 2 };
    expect(confirmation(tasks, "quit")!.detail).toBe(
      "2 scheduled tasks will not run while the app is closed."
    );
    const r = confirmation(tasks, "restart")!;
    expect(r.detail).toBe(
      "2 scheduled tasks pause only until the backend is back."
    );
    expect(r.buttons[0]).toBe("Restart backend");
  });

  it("asks with the could-not-tell text and Quit as the default when a probe failed", () => {
    const c = confirmation({ kind: "unknown", reason: "timeout" }, "quit")!;
    expect(c.message).toBe(
      "EvoScientist could not tell whether work is running."
    );
    expect(c.defaultId).toBe(0);
    expect(c.buttons[0]).toBe("Quit");
  });
});
