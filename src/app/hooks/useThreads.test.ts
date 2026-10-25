// @vitest-environment jsdom
//
// The sidebar labels a thread that has no labels from its messages, once per
// state. They come from the root conversation (`/state`): the bare record is
// the latest checkpoint of any namespace, which is the goal drafter's run
// while a goal's review waits, or the grader's while it grades.
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@langchain/langgraph-sdk";
import { backfillThreadLabels, exportThread, threadExport } from "./useThreads";

// exportThread builds its client from the saved config; it gets this one.
const sdk = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@langchain/langgraph-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph-sdk")>()),
  Client: vi.fn(function () {
    return sdk.client;
  }),
}));

type Update = (
  id: string,
  body: { metadata: Record<string, unknown> }
) => Promise<unknown>;

function clientWith(
  root: unknown[],
  record: unknown[],
  state: Record<string, unknown> = {}
) {
  const update = vi.fn<Update>(async () => ({}));
  const client = {
    threads: {
      get: vi.fn(async () => ({
        thread_id: "t",
        metadata: {},
        state_updated_at: "s1",
        values: { messages: record },
      })),
      getState: vi.fn(async () => ({
        values: { messages: root },
        ...state,
      })),
      update,
    },
  } as unknown as Client;
  return { client, update };
}

describe("backfillThreadLabels", () => {
  it("writes no label from a goal drafter's run while the conversation is empty", async () => {
    const drafter = [
      {
        id: "d1",
        type: "human",
        content: "<operation>draft</operation>\n\n<goal>\nWrite hello\n</goal>",
      },
      { id: "d2", type: "ai", content: "- The file exists" },
    ];
    const { client, update } = clientWith([], drafter);
    const derived = await backfillThreadLabels(client, "t", "k1", "s1");
    expect(derived).toEqual({ autoTitle: null, preview: null });
    for (const [, body] of update.mock.calls) {
      expect(body.metadata).not.toHaveProperty("auto_title");
      expect(body.metadata).not.toHaveProperty("preview");
    }
  });

  it("labels a thread from its conversation while the record is the grader's run", async () => {
    const root = [
      { id: "h1", type: "human", content: "Write hello" },
      { id: "a1", type: "ai", content: "Done." },
    ];
    const grader = [
      { id: "g1", type: "human", content: "This is grader iteration 0" },
      { id: "g2", type: "ai", content: '{"result": "satisfied"}' },
    ];
    const { client, update } = clientWith(root, grader);
    const derived = await backfillThreadLabels(client, "t", "k2", "s1");
    expect(derived).toEqual({ autoTitle: "Write hello", preview: "Done." });
    expect(update).toHaveBeenCalledWith("t", {
      metadata: expect.objectContaining({
        auto_title: "Write hello",
        preview: "Done.",
      }),
    });
  });
});

// An export is the thread record with the root's values, next and tasks from
// one /state read: the record's own values are a nested run's (the goal
// drafter's while a goal's review waits) or the last finished run's.
describe("threadExport", () => {
  const drafter = [
    { id: "d1", type: "human", content: "<operation>draft</operation>" },
  ];
  const root = [{ id: "h1", type: "human", content: "Write hello" }];
  const review = {
    next: ["model"],
    tasks: [{ id: "k1", name: "model", interrupts: [{ value: "review" }] }],
  };

  it("holds the root conversation while the record is a nested run's", async () => {
    const { client } = clientWith(root, drafter, review);
    const exported = await threadExport(client, "t");
    expect(exported.values).toEqual({ messages: root });
    expect(exported.thread_id).toBe("t");
    expect(exported.metadata).toEqual({});
    expect(exported).toMatchObject(review);
  });

  // The backend writes the record's values when a run ends, so while one
  // runs they are the last finished run's; the export holds the live root,
  // its messages and its pending tasks from the same read.
  it("holds the live root while a run is busy", async () => {
    const finished = [...root, { id: "a1", type: "ai", content: "Done." }];
    const live = [
      ...finished,
      { id: "h2", type: "human", content: "And again" },
    ];
    const { client } = clientWith(live, finished, {
      next: ["tools"],
      tasks: [{ id: "k2", name: "tools", interrupts: [] }],
    });
    const exported = await threadExport(client, "t");
    expect(exported.values).toEqual({ messages: live });
    expect(exported).toMatchObject({ next: ["tools"] });
  });

  // Without /state the record is all there is; the file says so.
  it("keeps the record, and says why, when the root state can't be read", async () => {
    const { client } = clientWith(root, drafter);
    vi.mocked(client.threads.getState).mockRejectedValueOnce(
      new Error("state failed")
    );
    const exported = await threadExport(client, "t");
    expect(exported.values).toEqual({ messages: drafter });
    expect(exported).toMatchObject({ state_error: "state failed" });
    expect(exported).not.toHaveProperty("tasks");
  });
});

// The download goes through threadExport.
describe("exportThread", () => {
  it("downloads what threadExport gives", async () => {
    const { client } = clientWith([], [{ id: "d1", type: "human" }], {});
    // patchClientStreamModes wraps these two.
    sdk.client = Object.assign(client, {
      runs: { stream: () => {}, joinStream: () => {} },
    });
    localStorage.setItem(
      "evoscientist-config",
      JSON.stringify({ deploymentUrl: "http://127.0.0.1:6290" })
    );
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return "blob:export";
        },
        revokeObjectURL: (url: string) => {
          revoked.push(url);
        },
      })
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    try {
      await exportThread("t", "Write hello");
      // The link is let go a tick later, still under the stub.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(revoked).toEqual(["blob:export"]);
      expect(click).toHaveBeenCalledOnce();
      expect(JSON.parse(await blobs[0].text()).values).toEqual({
        messages: [],
      });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      localStorage.clear();
    }
  });
});
