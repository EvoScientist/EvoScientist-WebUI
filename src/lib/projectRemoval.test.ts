import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@langchain/langgraph-sdk";
import {
  projectWork,
  removeProjectAndWork,
  stopProjectRuns,
} from "./projectRemoval";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import { projectAssistantIds } from "@/lib/projects";

const KEY = "/home/you/projA";

/** The graphs the fake backend has, one the WebUI doesn't know among them. */
const GRAPHS = ["EvoScientist", "scheduler", "expert-container-async", "new"];

interface BusyThread {
  thread_id: string;
  metadata: Record<string, string>;
}

/** A backend with these busy threads: a search returns the ones whose
 *  metadata has every value it asks for, a page at a time. Its assistants
 *  are one per graph for KEY and for /srv/projB. */
function fakeClient(busy: BusyThread[] = []) {
  const order: string[] = [];
  const assistants = [KEY, "/srv/projB"].flatMap((key) =>
    GRAPHS.map((graph) => ({
      assistant_id: workspaceAssistantId(graph, key),
      metadata: { workspace_dir: key },
    }))
  );
  const client = {
    assistants: {
      search: vi.fn(
        async ({ metadata = {} }: { metadata?: Record<string, string> }) =>
          assistants.filter(
            (a) => a.metadata.workspace_dir === metadata.workspace_dir
          )
      ),
    },
    threads: {
      search: vi.fn(
        async ({
          metadata = {},
          limit = 10,
          offset = 0,
        }: {
          metadata?: Record<string, string>;
          limit?: number;
          offset?: number;
        }) =>
          busy
            .filter((thread) =>
              Object.entries(metadata).every(
                ([name, value]) => thread.metadata[name] === value
              )
            )
            .slice(offset, offset + limit)
      ),
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
          // On a graph the WebUI doesn't know: the backend lists it.
          cron_id: "task-3",
          assistant_id: workspaceAssistantId("new", KEY),
          enabled: true,
          metadata: { run_kind: "scheduled_task", name: "Hourly" },
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
  assistants: GRAPHS.map((graph) => workspaceAssistantId(graph, KEY)),
  assistantsComplete: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("projectWork", () => {
  it("lists the project's running threads and its scheduled tasks that are on", async () => {
    const { client } = fakeClient([
      { thread_id: "t-1", metadata: { title: "Long run", workspace_dir: KEY } },
      { thread_id: "t-2", metadata: { workspace_dir: "/srv/projB" } },
    ]);

    const work = await projectWork(client, KEY);

    expect(work).toEqual({
      running: [{ id: "t-1", title: "Long run" }],
      tasks: [
        { id: "task-1", name: "Daily" },
        { id: "task-2", name: "Weekly" },
        { id: "task-3", name: "Hourly" },
      ],
      // The ones the WebUI knows, and the one only the backend lists.
      assistants: expect.arrayContaining([
        ...projectAssistantIds(KEY),
        workspaceAssistantId("new", KEY),
      ]),
      assistantsComplete: true,
    });
  });

  it("counts a thread on any assistant the backend lists for the project", async () => {
    const { client } = fakeClient([
      {
        thread_id: "new-1",
        metadata: { assistant_id: workspaceAssistantId("new", KEY) },
      },
      {
        thread_id: "new-2",
        metadata: { assistant_id: workspaceAssistantId("new", "/srv/projB") },
      },
    ]);

    const work = await projectWork(client, KEY);

    expect(work.running.map((t) => t.id)).toEqual(["new-1"]);
  });

  it("counts the work on the assistants it knows when the backend's list can't be read", async () => {
    const { client, raw } = fakeClient([
      {
        thread_id: "agent-1",
        metadata: {
          assistant_id: workspaceAssistantId("expert-container-async", KEY),
        },
      },
    ]);
    raw.assistants.search.mockRejectedValue(new Error("network"));

    const work = await projectWork(client, KEY);

    expect(work.running.map((t) => t.id)).toEqual(["agent-1"]);
    expect(work.tasks.map((t) => t.id)).toEqual(["task-1", "task-2"]);
  });

  it("counts a task on an assistant it knows when the backend lists none", async () => {
    const { client, raw } = fakeClient();
    raw.assistants.search.mockResolvedValue([]);
    raw.crons.search.mockResolvedValue([
      {
        cron_id: "writing",
        assistant_id: workspaceAssistantId("writing-agent", KEY),
        enabled: true,
        metadata: { run_kind: "scheduled_task", name: "Draft" },
      },
    ]);

    const work = await projectWork(client, KEY);

    expect(work.tasks).toEqual([{ id: "writing", name: "Draft" }]);
  });

  it("counts an async agent's thread by the assistant it runs on", async () => {
    // Made without metadata: its run adds only the graph and the assistant.
    const { client } = fakeClient([
      {
        thread_id: "agent-1",
        metadata: {
          graph_id: "expert-container-async",
          assistant_id: workspaceAssistantId("expert-container-async", KEY),
        },
      },
      {
        thread_id: "agent-2",
        metadata: {
          assistant_id: workspaceAssistantId(
            "expert-container-async",
            "/srv/projB"
          ),
        },
      },
    ]);

    const work = await projectWork(client, KEY);

    expect(work.running.map((t) => t.id)).toEqual(["agent-1"]);
  });

  it("lists a thread found by its folder and its assistant once", async () => {
    const { client } = fakeClient([
      {
        thread_id: "both",
        metadata: {
          workspace_dir: KEY,
          assistant_id: workspaceAssistantId("EvoScientist", KEY),
          title: "Both",
        },
      },
      {
        thread_id: "folder-only",
        metadata: { workspace_dir: KEY, title: "Folder only" },
      },
    ]);

    const work = await projectWork(client, KEY);

    expect(work.running).toEqual([
      { id: "both", title: "Both" },
      { id: "folder-only", title: "Folder only" },
    ]);
  });

  it("reads running threads past the first page", async () => {
    const { client } = fakeClient(
      Array.from({ length: 103 }, (_, i) => ({
        thread_id: `t-${i}`,
        metadata: { workspace_dir: KEY },
      }))
    );

    const work = await projectWork(client, KEY);

    expect(work.running).toHaveLength(103);
  });
});

describe("removeProjectAndWork", () => {
  it("pauses the tasks, removes the project, then stops the runs", async () => {
    const { client, order } = fakeClient([
      { thread_id: "t-1", metadata: { workspace_dir: KEY } },
    ]);
    stubRemoval(200, { workspace_dir: KEY }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(false)
    );

    expect(result).toEqual({ ok: true, unstopped: [], checked: true });
    expect(order).toEqual(["pause task-1", "remove", "cancel t-1"]);
  });

  it("turns the tasks on again and stops nothing when the removal fails", async () => {
    const { client, order } = fakeClient([
      { thread_id: "t-1", metadata: { workspace_dir: KEY } },
    ]);
    stubRemoval(500, { error: "unregister_failed" }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(true)
    );

    expect(result.ok).toBe(false);
    expect(order).toEqual(["pause task-1", "remove", "resume task-1"]);
  });

  it("stops the runs when the project is gone anyway", async () => {
    // The request timed out while the backend finished removing it.
    const { client, order } = fakeClient([
      { thread_id: "t-1", metadata: { workspace_dir: KEY } },
    ]);
    stubRemoval(504, { error: "backend_timeout" }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(false)
    );

    expect(result).toEqual({ ok: true, unstopped: [], checked: true });
    expect(order).toEqual(["pause task-1", "remove", "cancel t-1"]);
  });

  it("stops the runs when the backend no longer has the project", async () => {
    // Removed before, and the project list can't be read to tell.
    const { client, order } = fakeClient([
      { thread_id: "t-1", metadata: { workspace_dir: KEY } },
    ]);
    stubRemoval(404, { error: "not_registered" }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.reject(new Error("projects unreadable"))
    );

    expect(result).toEqual({ ok: true, unstopped: [], checked: true });
    expect(order).toEqual(["pause task-1", "remove", "cancel t-1"]);
  });

  it("reports a run it couldn't stop once the project is removed", async () => {
    const { client, raw, order } = fakeClient([
      { thread_id: "t-1", metadata: { workspace_dir: KEY, title: "Long" } },
      { thread_id: "t-2", metadata: { workspace_dir: KEY } },
    ]);
    raw.runs.cancel.mockImplementation(async (thread: string) => {
      if (thread === "t-1") {
        throw Object.assign(new Error("HTTP 500"), { status: 500 });
      }
      order.push(`cancel ${thread}`);
    });
    stubRemoval(200, { workspace_dir: KEY }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(false)
    );

    expect(result).toEqual({
      ok: true,
      unstopped: [{ id: "t-1", title: "Long" }],
      checked: true,
    });
    // The removed project's tasks stay paused.
    expect(order).toEqual(["pause task-1", "remove", "cancel t-2"]);
  });

  it("says it couldn't check the runs when it can't read them again", async () => {
    const { client, raw, order } = fakeClient();
    raw.threads.search.mockRejectedValue(new Error("network"));
    stubRemoval(200, { workspace_dir: KEY }, order);

    const result = await removeProjectAndWork(client, KEY, WORK, async () =>
      Promise.resolve(false)
    );

    // Others may be going too: the ones the dialog listed are still
    // stopped.
    expect(result).toEqual({ ok: true, unstopped: [], checked: false });
    expect(order).toContain("cancel t-1");
  });
});

describe("stopProjectRuns", () => {
  it("stops the runs left on a second try", async () => {
    const { client, raw } = fakeClient([
      { thread_id: "t-1", metadata: { workspace_dir: KEY, title: "Long" } },
    ]);
    raw.runs.cancel.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 500"), { status: 500 })
    );

    const first = await stopProjectRuns(client, KEY, WORK, []);
    const second = await stopProjectRuns(client, KEY, WORK, first.unstopped);

    expect(first.unstopped).toEqual([{ id: "t-1", title: "Long" }]);
    expect(second).toEqual({ unstopped: [], checked: true });
  });

  it("finds runs by the assistants it was given, without the backend listing them again", async () => {
    // Removed: the backend may no longer list the project's assistants.
    const { client, raw, order } = fakeClient([
      {
        thread_id: "agent-1",
        metadata: { assistant_id: workspaceAssistantId("new", KEY) },
      },
    ]);
    raw.assistants.search.mockResolvedValue([]);

    const result = await stopProjectRuns(client, KEY, WORK, []);

    expect(result).toEqual({ unstopped: [], checked: true });
    expect(order).toEqual(["cancel agent-1"]);
    expect(raw.assistants.search).not.toHaveBeenCalled();
  });

  it("stops the runs it found but says it couldn't check them all when the backend's list of assistants couldn't be read", async () => {
    const { client, raw, order } = fakeClient([
      {
        thread_id: "agent-1",
        metadata: {
          assistant_id: workspaceAssistantId("expert-container-async", KEY),
        },
      },
    ]);
    raw.assistants.search.mockRejectedValue(new Error("network"));
    const work = await projectWork(client, KEY);

    const result = await stopProjectRuns(client, KEY, work, []);

    expect(result).toEqual({ unstopped: [], checked: false });
    expect(order).toEqual(["cancel agent-1"]);
  });

  it("asks for the backend's list of assistants again, and checks them all once it answers", async () => {
    const { client, raw, order } = fakeClient([
      {
        thread_id: "new-1",
        metadata: { assistant_id: workspaceAssistantId("new", KEY) },
      },
    ]);
    raw.assistants.search.mockRejectedValueOnce(new Error("network"));
    const work = await projectWork(client, KEY);
    expect(work.running).toEqual([]);

    const result = await stopProjectRuns(client, KEY, work, []);

    expect(result).toEqual({ unstopped: [], checked: true });
    expect(order).toEqual(["cancel new-1"]);
  });
});
