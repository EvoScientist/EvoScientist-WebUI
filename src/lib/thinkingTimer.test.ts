import { describe, expect, it } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import {
  createThinkingClock,
  streamedModel,
  thoughtLabel,
  thoughtSeconds,
} from "./thinkingTimer";

const THOUGHT = "17 × 23 is 17×20 plus 17×3.";
const human = { id: "h1", type: "human", content: "17 × 23?" } as Message;
// A reply that has streamed only its reasoning so far.
const thinking = (id: string) =>
  ({
    id,
    type: "ai",
    content: [{ type: "thinking", thinking: THOUGHT }],
  } as unknown as Message);
// DeepSeek's shape: the reasoning outside the content.
const reasoningKwarg = (id: string) =>
  ({
    id,
    type: "ai",
    content: "",
    additional_kwargs: { reasoning_content: THOUGHT },
  } as unknown as Message);
// The first chunk of an OpenAI Responses reply: only it has the response's id.
const head = (id: string) =>
  ({
    id,
    type: "ai",
    content: [],
    response_metadata: { id, model_provider: "openai" },
  } as unknown as Message);
const toolResult = {
  id: "tool1",
  type: "tool",
  tool_call_id: "c1",
  content: "ok",
} as unknown as Message;
// A reply that has started, with nothing in it yet.
const empty = (id: string) =>
  ({ id, type: "ai", content: [] } as unknown as Message);
const answered = (id: string) =>
  ({
    id,
    type: "ai",
    content: [
      { type: "thinking", thinking: THOUGHT },
      { type: "text", text: "391" },
    ],
  } as unknown as Message);

// The model each message streamed from (useChat reads it from the stream's
// metadata): one model, unless a message names another.
const modelOf = (message: Message) =>
  (message as { model?: string }).model ?? "openai:gpt-6";
// A clock whose run was started here.
const startedClock = () => {
  const clock = createThinkingClock(modelOf);
  clock.runStarting();
  return clock;
};

describe("createThinkingClock", () => {
  it("times a reply from its thinking to its answer", () => {
    const clock = startedClock();
    clock.observe([human], true, 0);
    clock.observe([human, thinking("t1")], true, 1_000);
    clock.observe([human, thinking("t1")], true, 9_000);
    clock.observe([human, answered("t1")], true, 13_400);

    expect(thoughtSeconds("t1")).toBe(12);
  });

  // OpenAI's reasoning models think before any summary text streams.
  it("starts the clock when the reply shows up", () => {
    const clock = startedClock();
    clock.observe([human, empty("t14")], true, 0);
    clock.observe([human, thinking("t14")], true, 15_000);
    clock.observe([human, answered("t14")], true, 20_000);

    expect(thoughtSeconds("t14")).toBe(20);
  });

  // The same tool call shapes the chat reads.
  it.each([
    ["a tool call", { tool_calls: [{ id: "c1", name: "ls", args: {} }] }],
    [
      "an OpenAI tool call",
      {
        additional_kwargs: {
          tool_calls: [{ id: "c1", function: { name: "ls", arguments: "{}" } }],
        },
      },
    ],
    [
      "a tool_use block",
      {
        content: [
          { type: "thinking", thinking: THOUGHT },
          { type: "tool_use", id: "c1", name: "ls", input: {} },
        ],
      },
    ],
  ])("stops the clock when %s starts", (label, fields) => {
    const id = `t2 ${label}`;
    const clock = startedClock();
    clock.observe([human, thinking(id)], true, 0);
    clock.observe(
      [human, { ...thinking(id), ...fields } as unknown as Message],
      true,
      7_000
    );

    expect(thoughtSeconds(id)).toBe(7);
  });

  // A collapsed action group renders nothing: the time must not wait for it.
  it("keeps the time, whatever renders the reply later", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t3")], true, 0);
    clock.observe([human, answered("t3")], true, 3_000);
    clock.observe([human, answered("t3")], false, 300_000);
    createThinkingClock().observe([human, answered("t3")], false, 600_000);

    expect(thoughtSeconds("t3")).toBe(3);
  });

  // A reload or a thread opened again joins the stream: when the thinking
  // started is unknown.
  it("has no time for a run it did not start", () => {
    const clock = createThinkingClock();
    clock.observe([human, thinking("t4")], true, 0);
    clock.observe([human, answered("t4")], true, 5_000);

    expect(thoughtSeconds("t4")).toBeNull();
  });

  it("times only the runs started here", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t5")], true, 0);
    clock.observe([human, answered("t5")], false, 3_000);
    const next = [human, answered("t5"), human];
    clock.observe([...next, thinking("t6")], true, 4_000);
    clock.observe([...next, answered("t6")], false, 9_000);
    clock.runStarting();
    clock.observe(
      [...next, answered("t6"), human, thinking("t7")],
      true,
      10_000
    );
    clock.observe(
      [...next, answered("t6"), human, answered("t7")],
      true,
      12_000
    );

    expect(thoughtSeconds("t5")).toBe(3);
    expect(thoughtSeconds("t6")).toBeNull();
    expect(thoughtSeconds("t7")).toBe(2);
  });

  // Stopped, failed, or the stream ended early: when the thinking ended is
  // unknown, even once the answer comes in.
  it("has no time for a reply that stops before it answers", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t8")], true, 0);
    clock.observe([human, thinking("t8")], false, 4_000);
    clock.observe([human, answered("t8")], false, 6_000);
    clock.observe([human, answered("t8")], true, 7_000);

    expect(thoughtSeconds("t8")).toBeNull();
  });

  // Only a reply that streams while its run goes is timed.
  it("has no time for a reply that shows up after its run", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t15")], true, 0);
    clock.observe([human, answered("t15")], false, 1_000);
    clock.observe([human, answered("t15"), thinking("t16")], false, 2_000);
    clock.observe([human, answered("t15"), answered("t16")], false, 6_000);

    expect(thoughtSeconds("t16")).toBeNull();
  });

  // A failed model call's half answer is cut before the call is retried.
  it("times the retried reply, not the one cut", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t9")], true, 0);
    clock.observe([human], true, 2_000);
    clock.observe([human, thinking("t10")], true, 3_000);
    clock.observe([human, answered("t10")], true, 8_000);

    expect(thoughtSeconds("t9")).toBeNull();
    expect(thoughtSeconds("t10")).toBe(5);
  });

  // Timed again from its return, it would leave out the time before.
  it("has no time for a reply that leaves the stream and comes back", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t17")], true, 0);
    clock.observe([human], true, 3_000);
    clock.observe([human, thinking("t17")], true, 4_000);
    clock.observe([human, answered("t17")], true, 6_000);

    expect(thoughtSeconds("t17")).toBeNull();
  });

  // The clock follows the reply at the end of the stream.
  it.each([
    ["in its content", thinking],
    ["in reasoning_content", reasoningKwarg],
  ])(
    "times the reply after one that never answered, reasoning %s",
    (label, first) => {
      const [a, b] = [`t18 ${label}`, `t19 ${label}`];
      const clock = startedClock();
      clock.observe([human, first(a)], true, 0);
      clock.observe([human, first(a), thinking(b)], true, 2_000);
      clock.observe([human, first(a), answered(b)], true, 7_000);

      expect(thoughtSeconds(a)).toBeNull();
      expect(thoughtSeconds(b)).toBe(5);
    }
  );

  // OpenAI's Responses API gives its first chunk (response.created) an id of
  // its own, so the SDK streams the reply as an empty message followed by the
  // rest; the saved reply keeps the first id.
  it("times a reply streamed as an empty message and the rest", () => {
    const clock = startedClock();
    clock.observe([human, head("resp_1")], true, 0);
    clock.observe([human, head("resp_1"), thinking("lc_1")], true, 1_000);
    clock.observe([human, head("resp_1"), answered("lc_1")], true, 9_000);
    clock.observe([human, answered("resp_1")], true, 9_500);

    expect(thoughtSeconds("resp_1")).toBe(9);
    expect(thoughtSeconds("lc_1")).toBe(9);
  });

  it("times a reply split in two from its first update", () => {
    const clock = startedClock();
    clock.observe([human, head("resp_2"), thinking("lc_2")], true, 0);
    clock.observe([human, head("resp_2"), answered("lc_2")], true, 9_000);
    clock.observe([human, answered("resp_2")], true, 9_500);

    expect(thoughtSeconds("resp_2")).toBe(9);
  });

  // A short answer can land in the same update as the step's end, which
  // swaps in the saved reply.
  it("times a split reply saved before its answer shows", () => {
    const saved = {
      ...answered("resp_3"),
      response_metadata: { id: "resp_3" },
    } as unknown as Message;
    const clock = startedClock();
    clock.observe([human, head("resp_3")], true, 0);
    clock.observe([human, head("resp_3"), thinking("lc_3")], true, 1_000);
    clock.observe([human, saved], true, 9_000);

    expect(thoughtSeconds("resp_3")).toBe(9);
  });

  it("joins only a response's own first chunk to the rest", () => {
    const clock = startedClock();
    clock.observe([human, empty("t22")], true, 0);
    clock.observe([human, empty("t22"), thinking("t23")], true, 4_000);
    clock.observe([human, empty("t22"), answered("t23")], true, 7_000);

    expect(thoughtSeconds("t22")).toBeNull();
    expect(thoughtSeconds("t23")).toBe(3);
  });

  // A busy page can take a tool call, its result and the next reply at once.
  it("keeps a reply apart from the next one in the same update", () => {
    const calling = {
      id: "t24",
      type: "ai",
      content: "",
      tool_calls: [{ id: "c1", name: "ls", args: {} }],
    } as unknown as Message;
    const clock = startedClock();
    clock.observe([human, empty("t24")], true, 0);
    clock.observe([human, calling, toolResult, thinking("t25")], true, 5_000);
    clock.observe([human, calling, toolResult, answered("t25")], true, 8_000);

    expect(thoughtSeconds("t24")).toBe(5);
    expect(thoughtSeconds("t25")).toBe(3);
  });

  it("keeps a saved split reply apart from the next one in the same update", () => {
    const saved = {
      id: "r5",
      type: "ai",
      content: [{ type: "thinking", thinking: THOUGHT }],
      tool_calls: [{ id: "c1", name: "ls", args: {} }],
      response_metadata: { id: "r5" },
    } as unknown as Message;
    const next = [human, saved, toolResult, head("r6")];
    const clock = startedClock();
    clock.observe([human, head("r5")], true, 0);
    clock.observe([...next, thinking("lc_r6")], true, 5_000);
    clock.observe([...next, answered("lc_r6")], true, 8_000);

    expect(thoughtSeconds("r5")).toBe(5);
    expect(thoughtSeconds("r6")).toBe(3);
  });

  it("keeps a saved tool call apart from the next reply", () => {
    const saved = {
      id: "r8",
      type: "ai",
      content: [],
      tool_calls: [{ id: "c1", name: "ls", args: {} }],
      response_metadata: { id: "r8" },
    } as unknown as Message;
    const clock = startedClock();
    clock.observe([human, head("r8")], true, 0);
    clock.observe([human, saved, toolResult, thinking("t27")], true, 5_000);
    clock.observe([human, saved, toolResult, answered("t27")], true, 9_000);

    expect(thoughtSeconds("r8")).toBe(5);
    expect(thoughtSeconds("t27")).toBe(4);
  });

  // An old core keeps a failed call's first chunk; the retry's first chunk
  // and the rest of it can come in one update.
  it("joins the rest only to the first chunk right before it", () => {
    const retry = [human, head("r9"), head("r10")];
    const clock = startedClock();
    clock.observe([human, head("r9")], true, 0);
    clock.observe([...retry, thinking("lc_r10")], true, 5_000);
    clock.observe([...retry, answered("lc_r10")], true, 9_000);

    expect(thoughtSeconds("r9")).toBeNull();
    expect(thoughtSeconds("r10")).toBe(4);
  });

  // The first chunk took the place of a reply gone, so when it started is
  // unknown; the rest of it, coming later, doesn't give it a time.
  it("keeps a first chunk in the place of a reply gone untimed", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t26")], true, 0);
    clock.observe([human, head("r7")], true, 2_000);
    clock.observe([human, head("r7"), thinking("lc_r7")], true, 3_000);
    clock.observe([human, head("r7"), answered("lc_r7")], true, 6_000);

    expect(thoughtSeconds("r7")).toBeNull();
  });

  // A core without the model_call marks keeps a failed call's first chunk;
  // the retry is another response, with its own first chunk.
  it("keeps one response's first chunk apart from the next response", () => {
    const clock = startedClock();
    clock.observe([human, head("r1")], true, 0);
    clock.observe([human, head("r1"), head("r2")], true, 3_000);
    clock.observe(
      [human, head("r1"), head("r2"), thinking("lc_r2")],
      true,
      3_500
    );
    clock.observe(
      [human, head("r1"), head("r2"), answered("lc_r2")],
      true,
      8_000
    );

    expect(thoughtSeconds("r1")).toBeNull();
    expect(thoughtSeconds("r2")).toBe(5);
  });

  it("keeps two responses' first chunks apart in one update", () => {
    const clock = startedClock();
    clock.observe([human, head("r3"), head("r4")], true, 0);
    clock.observe(
      [human, head("r3"), head("r4"), thinking("lc_r4")],
      true,
      500
    );
    clock.observe(
      [human, head("r3"), head("r4"), answered("lc_r4")],
      true,
      4_000
    );

    expect(thoughtSeconds("r3")).toBeNull();
    expect(thoughtSeconds("r4")).toBe(4);
  });

  // An old core keeps a failed call's first chunk; a fallback model then
  // answers right after it.
  it("joins only parts one model streamed", () => {
    const fallback = (m: Message) =>
      ({ ...m, model: "anthropic:claude" } as unknown as Message);
    const clock = startedClock();
    clock.observe([human, head("rA")], true, 0);
    clock.observe([human, head("rA"), fallback(thinking("lb"))], true, 5_000);
    clock.observe([human, head("rA"), fallback(answered("lb"))], true, 9_000);

    expect(thoughtSeconds("rA")).toBeNull();
    expect(thoughtSeconds("lb")).toBe(4);
  });

  it("joins no parts without knowing their model", () => {
    const clock = createThinkingClock();
    clock.runStarting();
    clock.observe([human, head("resp_5"), thinking("lc_5")], true, 0);
    clock.observe([human, head("resp_5"), answered("lc_5")], true, 6_000);

    expect(thoughtSeconds("resp_5")).toBeNull();
    expect(thoughtSeconds("lc_5")).toBe(6);
  });

  // A reply whose id changed would be timed from the change.
  it("has no time for a reply that takes the place of one gone", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t20")], true, 0);
    clock.observe([human, thinking("t21")], true, 3_000);
    clock.observe([human, answered("t21")], true, 5_000);

    expect(thoughtSeconds("t20")).toBeNull();
    expect(thoughtSeconds("t21")).toBeNull();
  });

  it("has no time for a reply that answers in its first update", () => {
    const clock = startedClock();
    clock.observe([human, answered("t11")], true, 0);
    clock.observe([human, answered("t11")], true, 5_000);

    expect(thoughtSeconds("t11")).toBeNull();
  });

  it("counts whole seconds, never below zero", () => {
    const clock = startedClock();
    clock.observe([human, thinking("t12")], true, 0);
    clock.observe([human, answered("t12")], true, 1_999);
    clock.observe([human, answered("t12"), thinking("t13")], true, 5_000);
    clock.observe([human, answered("t12"), answered("t13")], true, 4_000);

    expect(thoughtSeconds("t12")).toBe(1);
    expect(thoughtSeconds("t13")).toBe(0);
  });

  it("keeps the latest 500 times", () => {
    const clock = startedClock();
    for (let i = 0; i <= 500; i++) {
      clock.observe([human, thinking(`cap${i}`)], true, i * 10_000);
      clock.observe([human, answered(`cap${i}`)], true, i * 10_000 + 2_000);
    }

    expect(thoughtSeconds("cap0")).toBeNull();
    expect(thoughtSeconds("cap1")).toBe(2);
    expect(thoughtSeconds("cap500")).toBe(2);
  });

  it("has no time for a message without an id", () => {
    expect(thoughtSeconds(undefined)).toBeNull();
  });
});

describe("streamedModel", () => {
  it("names the provider and the model", () => {
    expect(
      streamedModel({ ls_provider: "openai", ls_model_name: "gpt-6" })
    ).toBe("openai:gpt-6");
  });

  it.each([
    [undefined],
    [{ ls_provider: "openai" }],
    [{ ls_model_name: "gpt-6" }],
    [{ ls_provider: "openai", ls_model_name: 6 }],
  ])("names nothing from %j", (metadata) => {
    expect(streamedModel(metadata)).toBeUndefined();
  });
});

describe("thoughtLabel", () => {
  it.each([
    [null, "Thought"],
    [0, "Thought"],
    [12, "Thought for 12s"],
    [59, "Thought for 59s"],
    [60, "Thought for 1m"],
    [65, "Thought for 1m 5s"],
    [120, "Thought for 2m"],
  ])("labels %j as %j", (seconds, label) => {
    expect(thoughtLabel(seconds)).toBe(label);
  });
});
