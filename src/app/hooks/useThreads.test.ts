// @vitest-environment jsdom
//
// The sidebar labels a thread that has no labels from its messages, once per
// state. They come from the root conversation (`/state`): the bare record is
// the latest checkpoint of any namespace, which is the goal drafter's run
// while a goal's review waits, or the grader's while it grades.
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@langchain/langgraph-sdk";
import { backfillThreadLabels } from "./useThreads";

type Update = (
  id: string,
  body: { metadata: Record<string, unknown> }
) => Promise<unknown>;

function clientWith(root: unknown[], record: unknown[]) {
  const update = vi.fn<Update>(async () => ({}));
  const client = {
    threads: {
      get: vi.fn(async () => ({
        thread_id: "t",
        metadata: {},
        state_updated_at: "s1",
        values: { messages: record },
      })),
      getState: vi.fn(async () => ({ values: { messages: root } })),
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
