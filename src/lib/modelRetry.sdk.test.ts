// ModelRetryTracker against the SDK's real StreamManager / MessageTupleManager
// (the objects behind `useStream`), fed the event order the EvoScientist
// backend produces when a model call fails mid-stream and is retried.
import { describe, expect, it } from "vitest";
import {
  MessageTupleManager,
  StreamManager,
} from "@langchain/langgraph-sdk/ui";
import { ModelRetryTracker } from "./modelRetry";

type Values = {
  messages?: Array<{ id?: string; type: string; content: unknown }>;
};
type StreamEvent = { event: string; data: unknown };
type Step = StreamEvent | ((manager: StreamManager<Values>) => void);

const human = (id: string, content = "please say hello") => ({
  id,
  type: "human",
  content,
});
const chunk = (id: string, content: string) => ({
  event: "messages",
  data: [
    { type: "AIMessageChunk", id, content, tool_call_chunks: [] },
    { langgraph_checkpoint_ns: "model:1" },
  ],
});
// A tool message streaming into the root list (not something the backend
// does while a model call runs; it stands in for any later message).
const toolChunk = (id: string, content: string) => ({
  event: "messages",
  data: [
    { type: "ToolMessageChunk", id, content, tool_call_id: "call-1" },
    // No `tools:` namespace: the SDK would route that to a sub-agent.
    {},
  ],
});
const custom = (data: unknown) => ({ event: "custom", data });
const values = (messages: unknown[]) => ({
  event: "values",
  data: { messages },
});
const start = (call: string) =>
  custom({ type: "model_call", phase: "start", call });
const end = (call: string, status: string) =>
  custom({ type: "model_call", phase: "end", call, status });
const retry = custom({
  type: "model_retry",
  attempt: 2,
  wait_seconds: 1.1,
  reason: "Connection error.",
  agent: "EvoScientist",
});

// Runs the script through a StreamManager. A function step runs between
// events and sees the state after everything before it was processed.
async function play(
  script: Step[],
  onCustomEvent: (data: unknown, options: unknown) => void
) {
  const manager = new StreamManager<Values>(new MessageTupleManager(), {
    throttle: false,
    filterSubagentMessages: true,
  });
  async function* events() {
    for (const step of script) {
      if (typeof step === "function") step(manager);
      else yield step;
    }
  }
  let failure: unknown;
  await manager.start(async () => events() as never, {
    getMessages: (v: Values) => (v.messages ?? []) as never,
    setMessages: (v: Values, messages: unknown[]) =>
      ({ ...v, messages } as Values),
    initialValues: {},
    callbacks: {
      onCustomEvent: (data: unknown, options: unknown) =>
        onCustomEvent(data, options),
    } as never,
    onSuccess: () => undefined,
    onError: (error: unknown) => {
      failure = error;
    },
  });
  if (failure) throw failure;
  return manager;
}

const ids = (manager: StreamManager<Values>) =>
  (manager.values?.messages ?? []).map((m) => m.id);
const contentOf = (manager: StreamManager<Values>, id: string) =>
  manager.values?.messages?.find((m) => m.id === id)?.content;

function trackerWithNotices() {
  const shown: string[] = [];
  let dismissed = 0;
  const tracker = new ModelRetryTracker({
    show: (text) => shown.push(text),
    dismiss: () => {
      dismissed += 1;
    },
  });
  return {
    tracker,
    shown,
    dismissed: () => dismissed,
    onCustomEvent: (data: unknown, options: unknown) => {
      tracker.handle(data, options as never);
    },
  };
}

describe("ModelRetryTracker with the SDK's stream manager", () => {
  it("removes the cut-off answer at the retry and streams the retried answer cleanly", async () => {
    const t = trackerWithNotices();
    const seen: Record<string, unknown> = {};
    const manager = await play(
      [
        values([human("h1")]),
        start("c1"),
        chunk("p", "PARTIAL-0 "),
        chunk("p", "PARTIAL-1 "),
        end("c1", "failed"),
        (m) => (seen.beforeRetry = ids(m)),
        retry,
        (m) => (seen.duringWait = ids(m)),
        start("c2"),
        chunk("b", "Hello "),
        chunk("b", "world."),
        (m) => (seen.streaming = [ids(m), contentOf(m, "b")]),
        end("c2", "clean"),
        values([human("h1"), { id: "b", type: "ai", content: "Hello world." }]),
      ],
      t.onCustomEvent
    );
    expect(seen.beforeRetry).toEqual(["h1", "p"]);
    expect(seen.duringWait).toEqual(["h1"]);
    expect(seen.streaming).toEqual([["h1", "b"], "Hello world."]);
    expect(ids(manager)).toEqual(["h1", "b"]);
    expect(t.shown).toEqual([
      "Model request failed (Connection error.); retrying in 1 s (attempt 2)",
    ]);
    expect(t.dismissed()).toBe(1);
  });

  it("removes a failed model's answer when a fallback model starts", async () => {
    const t = trackerWithNotices();
    const seen: Record<string, unknown> = {};
    await play(
      [
        values([human("h1"), { id: "a0", type: "ai", content: "earlier" }]),
        start("c1"),
        chunk("p", "PARTIAL "),
        end("c1", "error"),
        start("c2"),
        (m) => (seen.afterFallbackStart = ids(m)),
        chunk("b", "Fallback answer."),
        (m) => (seen.fallbackStreaming = ids(m)),
      ],
      t.onCustomEvent
    );
    expect(seen.afterFallbackStart).toEqual(["h1", "a0"]);
    expect(seen.fallbackStreaming).toEqual(["h1", "a0", "b"]);
  });

  it("documents the SDK hazard the tail rule avoids: removing a message with another after it duplicates that one", async () => {
    const seen: Record<string, unknown> = {};
    await play(
      [
        values([human("h1")]),
        chunk("p", "PARTIAL "),
        toolChunk("t", "other "),
        (m) => {
          // A naive removal of `p`, not through the tracker.
          (
            m as unknown as {
              getMutateFn: (
                kind: string,
                history: Values
              ) => (update: (prev: Values) => Values) => void;
            }
          ).getMutateFn(
            "stream",
            {}
          )((prev) => ({
            messages: (prev.messages ?? []).filter((x) => x.id !== "p"),
          }));
        },
        toolChunk("t", "more"),
        (m) => (seen.after = ids(m)),
      ],
      () => {}
    );
    expect(seen.after).toEqual(["h1", "t", "t"]);
  });

  it("leaves the list alone when the failed answer is not its tail", async () => {
    const t = trackerWithNotices();
    const seen: Record<string, unknown> = {};
    await play(
      [
        values([human("h1")]),
        start("c1"),
        chunk("p", "PARTIAL "),
        toolChunk("t", "other "),
        end("c1", "failed"),
        retry,
        toolChunk("t", "more"),
        (m) => (seen.after = ids(m)),
      ],
      t.onCustomEvent
    );
    expect(seen.after).toEqual(["h1", "p", "t"]);
  });
});
