// Scheduled tasks are LangGraph crons on the `scheduler` graph. A cron created
// without `timezone` is stored with `timezone: null` and the server reads its
// schedule in UTC, so "every day at 09:00" ran at 17:00 in Beijing (#61).
// These tests go through the real SDK client with `fetch` stubbed, so they
// check the request the server actually receives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    deploymentUrl: "http://127.0.0.1:6174",
    langsmithApiKey: "",
  }),
}));

import {
  createScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from "./useScheduledTasks";

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
    });

    expect(createCall(calls)?.body).not.toHaveProperty("timezone");
  });
});

describe("updateScheduledTask", () => {
  it("keeps the edited task's time zone", async () => {
    const calls = mockServer((call) =>
      call.method === "DELETE"
        ? undefined
        : cron({ cron_id: "cron-2", timezone: "Europe/London" })
    );

    const { task, oldTaskDeleted } = await updateScheduledTask({
      cronId: "cron-1",
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 8 * * *",
      timezone: "Europe/London",
    });

    expect(createCall(calls)?.body).toMatchObject({
      schedule: "0 8 * * *",
      timezone: "Europe/London",
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(oldTaskDeleted).toBe(true);
    expect(task.timezone).toBe("Europe/London");
  });

  it("moves a task stored without a time zone to the browser's", async () => {
    const calls = mockServer((call) =>
      call.method === "DELETE" ? undefined : cron({ cron_id: "cron-2" })
    );

    await updateScheduledTask({
      cronId: "cron-1",
      name: "Daily",
      prompt: "Brief me",
      schedule: "0 9 * * *",
      timezone: null,
    });

    expect(createCall(calls)?.body).toMatchObject({
      timezone: "Asia/Shanghai",
    });
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
});
