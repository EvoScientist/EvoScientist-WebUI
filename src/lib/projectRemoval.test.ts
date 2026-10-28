import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@langchain/langgraph-sdk";
import { projectWork, removeProjectAndWork } from "./projectRemoval";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";

const KEY = "/home/you/projA";

function fakeClient(busy: unknown[] = []) {
  const order: string[] = [];
  const client = {
    threads: {
      search: vi.fn(async () => busy),
    },
    crons: {
      search: vi.fn(async () => [
        {
          cron_id: "task-1",
          assistant_id: workspaceAssistantId("scheduler", KEY),
          enabled: true,
          metadata: { run_kind: "scheduled_task", name: "Daily" },
        },
        {
          // On another of the project's assistants: the backend counts it.
          cron_id: "task-2",
          assistant_id: workspaceAssistantId("EvoScientist", KEY),
          enabled: true,
          metadata: { run_kind: "scheduled_task", name: "Weekly" },
        },
        {
          cron_id: "elsewhere",
          assistant_id: workspaceAssistantId("scheduler", "/srv/projB"),
          enabled: true,
          metadata: { run_kind: "scheduled_task", name: "Other" },
        },
      ]),
      update: vi.fn(async (id: string, payload: { enabled: boolean }) => {
        order.push(`${payload.enabled ? "resume" : "pause"} ${id}`);
        return {};
      }),
    },
    runs: {
      list: vi.fn(async (_thread: string, { status }: { status: string }) =>
        status === "running" ? [{ run_id: "run-1" }] : []
      ),
      cancel: vi.fn(async (thread: string) => {
        order.push(`cancel ${thread}`);
      }),
    },
  };
  return { client: client as unknown as Client, raw: client, order };
}

function stubRemoval(status: number, body: unknown, order: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      order.push("remove");
      return new Response(JSON.stringify(body), { status });
    })
  );
}

const WORK = {
  running: [{ id: "t-1", title: "x" }],
  tasks: [{ id: "task-1", name: "Daily" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("projectWork", () => {
  it("lists the project's running threads and its scheduled tasks that are on", async () => {
    const { client, raw } = fakeClient([
      { thread_id: "t-1", metadata: { title: "Long run" } },
    ]);

    const work = await projectWork(client, KEY);

    expect(work).toEqual({
      running: [{ id: "t-1", title: "Long run" }],
      tasks: [
        { id: "task-1", name: "Daily" },
        { id: "task-2", name: "Weekly" },
      ],
    });
    // Every graph's threads: a scheduled run or an agent counts too.
    expect(raw.threads.search).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "busy",
        metadata: { workspace_dir: KEY },
      })
    );
  });

  it("reads running threads past the first page", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        thread_id: `t-${from + i}`,
        metadata: {},
      }));
    const { client, raw } = fakeClient();
    raw.threads.search
      .mockResolvedValueOnce(page(100, 0))
      .mockResolvedValueOnce(page(3, 100));

    const work = await projectWork(client, KEY);

    expect(work.running).toHaveLength(103);
  });
});

describe("removeProjectAndWork", () => {
  it("pauses the tasks, removes the project, then stops the runs", async () => {
    const { client, order } = fakeClient([{ thread_id: "t-1", metadata: {} }]);
    stubRemoval(200, { workspace_dir: KEY }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(false)
    );

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["pause task-1", "remove", "cancel t-1"]);
  });

  it("turns the tasks on again and stops nothing when the removal fails", async () => {
    const { client, order } = fakeClient([{ thread_id: "t-1", metadata: {} }]);
    stubRemoval(500, { error: "unregister_failed" }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(true)
    );

    expect(result.ok).toBe(false);
    expect(order).toEqual(["pause task-1", "remove", "resume task-1"]);
  });

  it("stops the runs when the project is gone anyway", async () => {
    // The request timed out while the backend finished removing it.
    const { client, order } = fakeClient([{ thread_id: "t-1", metadata: {} }]);
    stubRemoval(504, { error: "backend_timeout" }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(false)
    );

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["pause task-1", "remove", "cancel t-1"]);
  });
});
