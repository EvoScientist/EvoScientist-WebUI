// @vitest-environment jsdom
//
// Scheduled tasks are LangGraph crons on the `scheduler` graph. A cron created
// without `timezone` is stored with `timezone: null` and the server reads its
// schedule in UTC, so "every day at 09:00" ran at 17:00 in Beijing (#61).
// These tests go through the real SDK client with `fetch` stubbed, so they
// check the request the server actually receives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    deploymentUrl: "http://127.0.0.1:6174",
    langsmithApiKey: "",
  }),
}));

import {
  assistantRecoveryNeeded,
  createScheduledTask,
  listScheduledTasks,
  runScheduledTaskNow,
  setScheduledTaskEnabled,
  updateScheduledTask,
  useScheduledTasks,
} from "./useScheduledTasks";

const target = {
  assistantId: "8b1f3c2a-4d5e-5f60-9a7b-1c2d3e4f5a6b",
  workspaceDir: "/home/you/projA",
};

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function cron(overrides: Record<string, unknown> = {}) {
  return {
    cron_id: "cron-1",
    assistant_id: "scheduler",
    thread_id: null,
    on_run_completed: "keep",
    end_time: null,
    schedule: "0 9 * * *",
    created_at: "2026-10-09T08:00:00+00:00",
    updated_at: "2026-10-09T08:00:00+00:00",
    payload: {},
    user_id: null,
    next_run_date: "2026-10-10T01:00:00+00:00",
    metadata: { run_kind: "scheduled_task", name: "Daily", prompt: "Brief me" },
    timezone: "Asia/Shanghai",
    enabled: true,
    ...overrides,
  };
}

function mockServer(respond: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const result = respond(call);
      return result === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    })
  );
  return calls;
}

// Captured before any spy, so a second stub in one test still reaches it.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

function stubBrowserTimeZone(timeZone: string | undefined) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return {
        ...realResolvedOptions.call(this),
        timeZone,
      } as Intl.ResolvedDateTimeFormatOptions;
    }
  );
}

const createCall = (calls: Call[]) =>
  calls.find((c) => c.method === "POST" && c.path === "/runs/crons");

beforeEach(() => stubBrowserTimeZone("Asia/Shanghai"));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createScheduledTask", () => {
  it("creates the cron in the browser's time zone", async () => {
    const calls = mockServer(() => cron());

    const task = await createScheduledTask({
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 9 * * *",
      target,
    });

    expect(createCall(calls)?.body).toMatchObject({
      schedule: "0 9 * * *",
      timezone: "Asia/Shanghai",
    });
    expect(task.timezone).toBe("Asia/Shanghai");
  });

  it("leaves the time zone to the server when the browser reports none", async () => {
    stubBrowserTimeZone(undefined);
    const calls = mockServer(() => cron({ timezone: null }));

    await createScheduledTask({
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 9 * * *",
      target,
    });

    expect(createCall(calls)?.body).not.toHaveProperty("timezone");
  });
});

describe("scheduled tasks run in the backend's folder", () => {
  it("creates the cron on the folder's scheduler assistant, tagged with the folder", async () => {
    const calls = mockServer(() => cron());

    await createScheduledTask({
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 9 * * *",
      target,
    });

    expect(createCall(calls)?.body).toMatchObject({
      assistant_id: target.assistantId,
      metadata: { workspace_dir: "/home/you/projA" },
    });
  });

  it("runs a task now on the folder's scheduler assistant", async () => {
    const calls = mockServer((call) =>
      call.path === "/threads"
        ? { thread_id: "t-1", metadata: {} }
        : { run_id: "r-1" }
    );

    await runScheduledTaskNow(
      { cron_id: "cron-1", name: "Daily", prompt: "Brief me", input: {} },
      target
    );

    const thread = calls.find((c) => c.path === "/threads");
    const run = calls.find((c) => c.path === "/threads/t-1/runs");
    expect(thread?.body?.metadata).toMatchObject({
      workspace_dir: "/home/you/projA",
    });
    expect(run?.body).toMatchObject({
      assistant_id: target.assistantId,
      metadata: { workspace_dir: "/home/you/projA" },
    });
  });
});

describe("runScheduledTaskNow with a rubric", () => {
  it("runs with the task's stored input, so its rubric grades the run", async () => {
    const calls = mockServer((call) =>
      call.path === "/threads"
        ? { thread_id: "t-1", metadata: {} }
        : { run_id: "r-1" }
    );

    await runScheduledTaskNow(
      {
        cron_id: "cron-1",
        name: "Daily",
        prompt: "Brief me",
        input: {
          messages: [{ role: "user", content: "old" }],
          rubric: "- at least 3 papers",
        },
      },
      target
    );

    const run = calls.find((c) => c.path === "/threads/t-1/runs");
    expect(run?.body?.input).toEqual({
      messages: [{ role: "user", content: "Brief me" }],
      rubric: "- at least 3 papers",
    });
  });
});

describe("updateScheduledTask", () => {
  const patchCalls = (calls: Call[]) =>
    calls.filter(
      (c) => c.method === "PATCH" && c.path === "/runs/crons/cron-1"
    );

  it("edits the task in place and keeps its time zone", async () => {
    const calls = mockServer(() =>
      cron({ timezone: "Europe/London", enabled: false })
    );

    const task = await updateScheduledTask({
      cronId: "cron-1",
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 8 * * *",
      timezone: "Europe/London",
      input: {},
    });

    expect(patchCalls(calls)).toHaveLength(1);
    expect(patchCalls(calls)[0].body).toMatchObject({
      schedule: "0 8 * * *",
      timezone: "Europe/London",
      input: { messages: [{ role: "user", content: "Brief me" }] },
      metadata: { name: "Daily", prompt: "Brief me" },
    });
    expect(patchCalls(calls)[0].body).not.toHaveProperty("enabled");
    expect(
      calls.some((c) => c.method === "POST" || c.method === "DELETE")
    ).toBe(false);
    expect(task).toMatchObject({ cron_id: "cron-1", enabled: false });
  });

  it("moves a task stored without a time zone to the browser's", async () => {
    const calls = mockServer(() => cron());

    await updateScheduledTask({
      cronId: "cron-1",
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 9 * * *",
      timezone: null,
      input: {},
    });

    expect(patchCalls(calls)[0].body).toMatchObject({
      timezone: "Asia/Shanghai",
    });
  });

  it("replaces only the message of the task's input, keeping its rubric", async () => {
    const calls = mockServer((call) =>
      call.path === "/runs/crons/search"
        ? [
            cron({
              payload: {
                input: {
                  messages: [{ role: "user", content: "Brief me" }],
                  rubric: "- at least 3 papers",
                },
              },
            }),
          ]
        : cron()
    );
    const [task] = await listScheduledTasks();

    await updateScheduledTask({
      cronId: task.cron_id,
      name: task.name,
      prompt: "Brief me twice",
      schedule: task.schedule,
      timezone: task.timezone,
      input: task.input,
    });

    expect(patchCalls(calls)[0].body?.input).toEqual({
      messages: [{ role: "user", content: "Brief me twice" }],
      rubric: "- at least 3 papers",
    });
  });
});

describe("setScheduledTaskEnabled", () => {
  const daily = { cron_id: "cron-1", schedule: "0 9 * * *" };

  it("pauses a task without touching its schedule", async () => {
    const calls = mockServer(() => cron({ enabled: false }));

    const task = await setScheduledTaskEnabled(daily, false);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/runs/crons/cron-1",
    });
    expect(calls[0].body).toEqual({ enabled: false });
    expect(task.enabled).toBe(false);
  });

  it("resumes a task with its schedule, so the next run counts from now", async () => {
    const calls = mockServer(() => cron({ enabled: true }));

    const task = await setScheduledTaskEnabled(daily, true);

    expect(calls[0].body).toEqual({ enabled: true, schedule: "0 9 * * *" });
    expect(task.enabled).toBe(true);
  });
});

describe("listScheduledTasks", () => {
  it("reads each task's time zone, null for a cron stored without one", async () => {
    mockServer((call) =>
      call.path === "/runs/crons/search"
        ? [
            cron({ cron_id: "local", timezone: "Europe/London" }),
            cron({ cron_id: "legacy", timezone: null }),
          ]
        : cron()
    );

    const tasks = await listScheduledTasks();

    expect(tasks.map((t) => [t.cron_id, t.timezone])).toEqual([
      ["local", "Europe/London"],
      ["legacy", null],
    ]);
  });

  it("reads whether each task is paused", async () => {
    mockServer((call) =>
      call.path === "/runs/crons/search"
        ? [
            cron({ cron_id: "on", enabled: true }),
            cron({ cron_id: "off", enabled: false }),
          ]
        : cron()
    );

    const tasks = await listScheduledTasks();

    expect(tasks.map((t) => [t.cron_id, t.enabled])).toEqual([
      ["on", true],
      ["off", false],
    ]);
  });
});

describe("assistant recovery", () => {
  it("reads the folder again when the scheduler assistant is gone", async () => {
    // The server's answer to a cron for an assistant it doesn't have, through
    // the real SDK client.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: `Assistant '${target.assistantId}' not found`,
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const error = await createScheduledTask({
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 9 * * *",
      target,
    }).catch((e: unknown) => e);

    expect(assistantRecoveryNeeded(error)).toBe(true);
  });
});

describe("useScheduledTasks", () => {
  it("reports loading from the refresh on, and keeps only the newest read", async () => {
    const reads: Array<(crons: unknown[]) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            reads.push((crons) =>
              resolve(
                new Response(JSON.stringify(crons), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                })
              )
            )
          )
      )
    );
    const { result } = renderHook(() => useScheduledTasks());
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => {
      reads[0]([
        cron({ metadata: { run_kind: "scheduled_task", name: "First" } }),
      ]);
    });
    expect(result.current.loading).toBe(false);

    act(() => result.current.refresh());
    expect(result.current.loading).toBe(true);
    act(() => result.current.refresh());
    await waitFor(() => expect(reads).toHaveLength(3));

    await act(async () => {
      reads[2]([
        cron({ metadata: { run_kind: "scheduled_task", name: "New" } }),
      ]);
    });
    await act(async () => {
      reads[1]([
        cron({ metadata: { run_kind: "scheduled_task", name: "Old" } }),
      ]);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.tasks.map((t) => t.name)).toEqual(["New"]);
  });

  it("keeps the latest refresh loading when an older read finishes before cleanup", async () => {
    const reads: Array<(name: string) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            reads.push((name) =>
              resolve(
                new Response(
                  JSON.stringify([
                    cron({ metadata: { run_kind: "scheduled_task", name } }),
                  ]),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  }
                )
              )
            )
          )
      )
    );
    const { result } = renderHook(() => useScheduledTasks());
    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => reads[0]("First"));

    act(() => result.current.refresh());
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => {
      result.current.refresh();
      reads[1]("Superseded");
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    expect(reads).toHaveLength(3);
    expect(result.current.loading).toBe(true);
    expect(result.current.tasks.map((task) => task.name)).toEqual(["First"]);

    await act(async () => reads[2]("Current"));
    expect(result.current.loading).toBe(false);
    expect(result.current.tasks.map((task) => task.name)).toEqual(["Current"]);
  });
});
