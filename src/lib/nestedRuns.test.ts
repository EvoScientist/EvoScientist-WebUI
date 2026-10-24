import { describe, expect, it, vi } from "vitest";
import type { Client } from "@langchain/langgraph-sdk";
import { isNestedRunEvent, withoutNestedRuns } from "./nestedRuns";
import { makeClient } from "./streamMode";

const EVENTS = [
  "values",
  "values|GoalMiddleware.before_agent:1",
  "custom|GoalMiddleware.before_agent:1",
  "messages|tools:x",
];

async function* emit(names: string[]) {
  for (const event of names) yield { event, data: { event } };
}

function fakeClient() {
  const runs = {
    stream: vi.fn(() => emit(EVENTS)),
    joinStream: vi.fn(() => emit(EVENTS)),
    get: vi.fn(async () => ({ run_id: "r1" })),
  };
  const threads = { get: vi.fn() };
  return { runs, threads };
}

async function names(stream: AsyncIterable<{ event: string }>) {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk.event);
  return out;
}

describe("isNestedRunEvent", () => {
  it.each([
    ["values", false],
    ["values|tools:a|model:1", false],
    ["custom|GoalMiddleware.before_agent:1", false],
    ["values|GoalMiddleware.before_agent:1|draft_goal:2", true],
    ["messages|EvoRubricMiddleware.after_agent:1", true],
    ["updates|EvoRubricMiddleware.after_agent:1", true],
  ])("%s is nested: %s", (event, nested) => {
    expect(isNestedRunEvent(event)).toBe(nested);
  });
});

describe("withoutNestedRuns", () => {
  it("drops a nested run's events from runs.stream, keeping custom and sub-agent ones", async () => {
    const raw = fakeClient();
    const client = withoutNestedRuns(raw as unknown as Client);
    const stream = client.runs.stream("t1", "a1", { streamSubgraphs: true });
    expect(await names(stream as AsyncIterable<{ event: string }>)).toEqual([
      "values",
      "custom|GoalMiddleware.before_agent:1",
      "messages|tools:x",
    ]);
    expect(raw.runs.stream).toHaveBeenCalledWith("t1", "a1", {
      streamSubgraphs: true,
    });
  });

  it("filters runs.joinStream the same way", async () => {
    const raw = fakeClient();
    const client = withoutNestedRuns(raw as unknown as Client);
    const stream = client.runs.joinStream("t1", "r1", { lastEventId: "-1" });
    expect(await names(stream as AsyncIterable<{ event: string }>)).toEqual([
      "values",
      "custom|GoalMiddleware.before_agent:1",
      "messages|tools:x",
    ]);
    expect(raw.runs.joinStream).toHaveBeenCalledWith("t1", "r1", {
      lastEventId: "-1",
    });
  });

  it("leaves every other member to the original client", async () => {
    const raw = fakeClient();
    const client = withoutNestedRuns(raw as unknown as Client);
    expect(client.threads).toBe(raw.threads);
    await client.runs.get("t1", "r1");
    expect(raw.runs.get).toHaveBeenCalledWith("t1", "r1");
  });

  // The SDK's clients fetch through a private method, so their calls have
  // to run on the real instance: on a copy, Stop's runs.cancel threw and
  // the run went on on the server.
  it("keeps a real client's other calls working, Stop's cancel included", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    try {
      const client = withoutNestedRuns(
        makeClient({ apiUrl: "http://127.0.0.1:1" })
      );
      await client.runs.cancel("t1", "r1");
      await client.runs.get("t1", "r1");
      await client.threads.getState("t1");
      expect(calls).toEqual([
        expect.stringMatching(/^POST .*\/threads\/t1\/runs\/r1\/cancel/),
        expect.stringMatching(/^GET .*\/threads\/t1\/runs\/r1$/),
        expect.stringMatching(/^GET .*\/threads\/t1\/state/),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
