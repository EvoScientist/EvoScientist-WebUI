import { describe, expect, it, vi } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import {
  callEndedBadly,
  callIsDiscardable,
  failedCallOutputIds,
  modelRetryText,
  openModelCall,
  parseModelCallEvent,
  parseModelRetryEvent,
  ModelRetryTracker,
  createRetryToasts,
  withoutTrailingMessages,
} from "./modelRetry";

const human = (id: string): Message => ({ id, type: "human", content: "hi" });
const ai = (id: string, content = "text"): Message => ({
  id,
  type: "ai",
  content,
});
const tool = (id: string): Message =>
  ({ id, type: "tool", content: "ok", tool_call_id: "c1" } as Message);

describe("parseModelCallEvent", () => {
  it("reads the start and end marks the backend puts around each provider call", () => {
    expect(
      parseModelCallEvent({ type: "model_call", phase: "start", call: "a1" })
    ).toEqual({ phase: "start", call: "a1" });
    expect(
      parseModelCallEvent({
        type: "model_call",
        phase: "end",
        call: "a1",
        status: "clean",
      })
    ).toEqual({ phase: "end", call: "a1", status: "clean" });
    expect(
      parseModelCallEvent({
        type: "model_call",
        phase: "end",
        call: "a1",
        status: "error",
      })
    ).toMatchObject({ status: "error" });
  });

  it("treats an end without a known status as failed, as the CLI does", () => {
    expect(
      parseModelCallEvent({ type: "model_call", phase: "end", call: "a1" })
    ).toMatchObject({ status: "failed" });
    expect(
      parseModelCallEvent({
        type: "model_call",
        phase: "end",
        call: "a1",
        status: "weird",
      })
    ).toMatchObject({ status: "failed" });
  });

  it("ignores other custom traffic and malformed marks", () => {
    expect(parseModelCallEvent(null)).toBeNull();
    expect(parseModelCallEvent("model_call")).toBeNull();
    expect(
      parseModelCallEvent({ type: "subagent", phase: "start", id: "x" })
    ).toBeNull();
    expect(
      parseModelCallEvent({ type: "model_call", phase: "middle", call: "a1" })
    ).toBeNull();
    expect(
      parseModelCallEvent({ type: "model_call", phase: "start" })
    ).toBeNull();
    expect(
      parseModelCallEvent({ type: "model_call", phase: "start", call: "" })
    ).toBeNull();
    expect(
      parseModelCallEvent({
        evoscientist: { kind: "fallback_notice", text: "x" },
      })
    ).toBeNull();
  });
});

describe("parseModelRetryEvent", () => {
  it("reads the retry the backend announces before it waits", () => {
    expect(
      parseModelRetryEvent({
        type: "model_retry",
        attempt: 2,
        wait_seconds: 1.1,
        reason: "Connection error.",
        budget_left_seconds: 58.9,
        cause: "exception",
        agent: "EvoScientist",
      })
    ).toEqual({
      attempt: 2,
      waitSeconds: 1.1,
      reason: "Connection error.",
      agent: "EvoScientist",
    });
  });

  it("fills safe defaults for missing or mistyped fields", () => {
    expect(parseModelRetryEvent({ type: "model_retry" })).toEqual({
      attempt: 1,
      waitSeconds: 0,
      reason: "",
      agent: "",
    });
    expect(
      parseModelRetryEvent({
        type: "model_retry",
        attempt: "2",
        wait_seconds: -3,
        reason: 7,
        agent: null,
      })
    ).toEqual({ attempt: 1, waitSeconds: 0, reason: "", agent: "" });
    expect(
      parseModelRetryEvent({
        type: "model_retry",
        attempt: 2.5,
        wait_seconds: Number.NaN,
      })
    ).toMatchObject({ attempt: 1, waitSeconds: 0 });
  });

  it("ignores everything else", () => {
    expect(parseModelRetryEvent(undefined)).toBeNull();
    expect(
      parseModelRetryEvent({ type: "model_call", phase: "start", call: "a" })
    ).toBeNull();
    expect(parseModelRetryEvent([{ type: "model_retry" }])).toBeNull();
  });
});

describe("modelRetryText", () => {
  const base = {
    attempt: 2,
    waitSeconds: 4,
    reason: "Connection error.",
    agent: "EvoScientist",
  };

  it("matches the CLI's wording for the main agent", () => {
    expect(modelRetryText(base, { subagent: false })).toBe(
      "Model request failed (Connection error.); retrying in 4 s (attempt 2)"
    );
  });

  it("names a sub-agent's retry", () => {
    expect(
      modelRetryText({ ...base, agent: "code-agent" }, { subagent: true })
    ).toBe(
      "code-agent: Model request failed (Connection error.); retrying in 4 s (attempt 2)"
    );
    expect(modelRetryText({ ...base, agent: "" }, { subagent: true })).toBe(
      "Model request failed (Connection error.); retrying in 4 s (attempt 2)"
    );
  });

  it("shows a sub-second wait with one decimal and fills an unknown reason", () => {
    expect(
      modelRetryText(
        { attempt: 1, waitSeconds: 0.4, reason: "", agent: "" },
        { subagent: false }
      )
    ).toBe(
      "Model request failed (transient error); retrying in 0.4 s (attempt 1)"
    );
    expect(
      modelRetryText({ ...base, waitSeconds: 1.1 }, { subagent: false })
    ).toContain("retrying in 1 s");
  });

  it("rounds whole seconds like Python's .0f: an exact half goes to the even neighbour", () => {
    const at = (waitSeconds: number) =>
      modelRetryText({ ...base, waitSeconds }, { subagent: false }).match(
        /retrying in (\S+) s/
      )?.[1];
    expect([1.5, 2.5, 3.5, 8.5, 9.96, 4].map(at)).toEqual([
      "2",
      "2",
      "4",
      "8",
      "10",
      "4",
    ]);
  });

  it("caps a long provider error so the toast stays readable", () => {
    const text = modelRetryText(
      { ...base, reason: `503: ${"x".repeat(1000)}` },
      { subagent: false }
    );
    expect(text.length).toBeLessThanOrEqual(240);
    expect(text).toContain("…");
    expect(text.endsWith("retrying in 4 s (attempt 2)")).toBe(true);
  });
});

describe("call records", () => {
  it("records the AI messages present when a call starts", () => {
    const record = openModelCall("c1", [human("h1"), ai("a0"), tool("t0")]);
    expect(record).toEqual({
      call: "c1",
      state: "open",
      baseline: new Set(["a0"]),
    });
  });

  it("knows which ends are bad and which calls may be dropped", () => {
    const record = openModelCall("c1", []);
    expect(callEndedBadly(record)).toBe(false);
    expect(callIsDiscardable(record)).toBe(true);
    for (const state of ["error", "failed"] as const) {
      expect(callEndedBadly({ ...record, state })).toBe(true);
      expect(callIsDiscardable({ ...record, state })).toBe(true);
    }
    expect(callEndedBadly({ ...record, state: "clean" })).toBe(false);
    expect(callIsDiscardable({ ...record, state: "clean" })).toBe(false);
  });

  it("finds the AI messages a call added after it started", () => {
    const record = openModelCall("c1", [human("h1"), ai("a0")]);
    const now = [human("h1"), ai("a0"), ai("partial"), tool("t9")];
    expect(failedCallOutputIds(record, now)).toEqual(new Set(["partial"]));
    expect(failedCallOutputIds(record, [human("h1"), ai("a0")]).size).toBe(0);
  });

  it("removes the given messages only when they are the tail of the list", () => {
    const list = [human("h1"), ai("a0"), ai("partial")];
    expect(withoutTrailingMessages(list, new Set(["partial"]))).toEqual([
      human("h1"),
      ai("a0"),
    ]);
    expect(withoutTrailingMessages(list, new Set())).toBe(list);
    expect(withoutTrailingMessages(list, new Set(["nope"]))).toBe(list);
    // Something after it: removing would shift that message's SDK slot.
    const notTail = [human("h1"), ai("partial"), tool("t1")];
    expect(withoutTrailingMessages(notTail, new Set(["partial"]))).toBe(
      notTail
    );
  });
});

// A stand-in for the SDK's live stream values and its `mutate`.
function liveValues(initial: Message[]) {
  let messages = initial;
  const mutate = vi.fn(
    (update: (prev: { messages?: unknown[] }) => { messages?: unknown[] }) => {
      const next = update({ messages });
      if (next.messages) messages = next.messages as Message[];
    }
  );
  return {
    mutate,
    get ids() {
      return messages.map((m) => m.id);
    },
    set(next: Message[]) {
      messages = next;
    },
    append(m: Message) {
      messages = [...messages, m];
    },
  };
}

describe("ModelRetryTracker", () => {
  const start = (call: string) => ({
    type: "model_call",
    phase: "start",
    call,
  });
  const end = (call: string, status: string) => ({
    type: "model_call",
    phase: "end",
    call,
    status,
  });
  const retry = (agent = "EvoScientist") => ({
    type: "model_retry",
    attempt: 2,
    wait_seconds: 1.1,
    reason: "Connection error.",
    agent,
  });
  const setup = (initial: Message[] = [human("h1")]) => {
    const live = liveValues(initial);
    const notices = { show: vi.fn(), dismiss: vi.fn() };
    const tracker = new ModelRetryTracker(notices);
    const send = (data: unknown, namespace: string[] = []) =>
      tracker.handle(data, { namespace, mutate: live.mutate });
    return { live, notices, tracker, send };
  };

  it("consumes only model-call marks and retries", () => {
    const { send } = setup();
    expect(send(start("c1"))).toBe(true);
    expect(send(retry())).toBe(true);
    expect(send({ type: "subagent", phase: "start", id: "x" })).toBe(false);
    expect(send({ evoscientist: { kind: "fallback_notice", text: "x" } })).toBe(
      false
    );
  });

  it("drops a failed call's output at the retry and keeps the retried answer", () => {
    const { live, notices, send } = setup();
    send(start("c1"));
    live.append(ai("partial"));
    send(end("c1", "failed"));
    expect(live.ids).toEqual(["h1", "partial"]);
    send(retry());
    expect(live.ids).toEqual(["h1"]);
    expect(notices.show).toHaveBeenCalledWith(
      "Model request failed (Connection error.); retrying in 1 s (attempt 2)",
      1.1
    );
    send(start("c2"));
    live.append(ai("answer"));
    send(end("c2", "clean"));
    expect(live.ids).toEqual(["h1", "answer"]);
    expect(notices.dismiss).toHaveBeenCalledTimes(1);
  });

  it("drops a call that never sent its end mark when a retry follows", () => {
    const { live, send } = setup();
    send(start("c1"));
    live.append(ai("partial"));
    send(retry());
    expect(live.ids).toEqual(["h1"]);
  });

  it("drops a failed call's output when a fallback model starts", () => {
    const { live, send } = setup([human("h1"), ai("a0")]);
    send(start("c1"));
    live.append(ai("partial"));
    send(end("c1", "error"));
    send(start("c2"));
    expect(live.ids).toEqual(["h1", "a0"]);
  });

  it("keeps clean answers, answers whose end mark never came, and answers another call's end mark names", () => {
    const { live, send } = setup();
    send(start("c1"));
    live.append(ai("a1"));
    send(end("c1", "clean"));
    send(start("c2"));
    live.append(ai("a2"));
    send(start("c3"));
    live.append(ai("a3"));
    send(end("other", "failed"));
    send(start("c4"));
    expect(live.ids).toEqual(["h1", "a1", "a2", "a3"]);
  });

  it("ignores a second end mark for a call that already ended clean, as the CLI does", () => {
    const { live, send } = setup();
    send(start("c1"));
    live.append(ai("a1"));
    send(end("c1", "clean"));
    send(end("c1", "failed"));
    send(start("c2"));
    expect(live.ids).toEqual(["h1", "a1"]);
  });

  it("leaves the list alone when the failed output is not its tail", () => {
    const { live, send } = setup();
    send(start("c1"));
    live.append(ai("partial"));
    live.append(tool("t1"));
    send(end("c1", "failed"));
    send(retry());
    expect(live.ids).toEqual(["h1", "partial", "t1"]);
  });

  it("announces a sub-agent's retry by name without touching the main transcript", () => {
    const { live, notices, send } = setup();
    send(start("m1"));
    live.append(ai("partial"));
    send(end("m1", "failed"));
    send(start("s1"), ["tools:abc"]);
    send(end("s1", "failed"), ["tools:abc"]);
    send(retry("code-agent"), ["tools:abc"]);
    expect(notices.show).toHaveBeenCalledWith(
      "code-agent: Model request failed (Connection error.); retrying in 1 s (attempt 2)",
      1.1
    );
    expect(live.ids).toEqual(["h1", "partial"]);
    // The main agent's clean call does not close the sub-agent's notice…
    send(start("m2"));
    send(end("m2", "clean"));
    expect(notices.dismiss).not.toHaveBeenCalled();
    // …the sub-agent's retried call does.
    send(start("s2"), ["tools:abc"]);
    send(end("s2", "clean"), ["tools:abc"]);
    expect(notices.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the notice while the retried attempt falls back, and closes it when the fallback answers", () => {
    const { notices, send } = setup();
    send(start("c1"));
    send(end("c1", "failed"));
    send(retry());
    send(start("c2"));
    send(end("c2", "failed"));
    expect(notices.dismiss).not.toHaveBeenCalled();
    send(start("c3"));
    send(end("c3", "clean"));
    expect(notices.dismiss).toHaveBeenCalledTimes(1);
  });

  it("closes the notice only for the call made after the retry", () => {
    const { notices, send } = setup();
    send(start("c1"));
    send(retry());
    // A late clean end of the call that was retried is not the recovery.
    send(end("c1", "clean"));
    expect(notices.dismiss).not.toHaveBeenCalled();
  });

  it("reset forgets the run's calls and closes a notice that is up", () => {
    const { live, notices, tracker, send } = setup();
    tracker.reset();
    expect(notices.dismiss).not.toHaveBeenCalled();
    send(start("c1"));
    live.append(ai("partial"));
    send(end("c1", "failed"));
    send(retry());
    tracker.reset();
    expect(notices.dismiss).toHaveBeenCalledTimes(1);
    // A failed call from before the reset is not dropped by the next start.
    send(start("c2"));
    live.append(ai("kept"));
    send(end("c2", "failed"));
    tracker.reset();
    send(start("c3"));
    expect(live.ids).toEqual(["h1", "kept"]);
  });

  it("still announces retries when the SDK passes no mutate", () => {
    const notices = { show: vi.fn(), dismiss: vi.fn() };
    const tracker = new ModelRetryTracker(notices);
    tracker.handle(start("c1"), { namespace: [] });
    tracker.handle(retry(), { namespace: [] });
    tracker.handle(start("c2"));
    tracker.handle(end("c2", "clean"));
    expect(notices.show).toHaveBeenCalledTimes(1);
    expect(notices.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("createRetryToasts", () => {
  const api = () => {
    const warning = vi.fn();
    const dismiss = vi.fn();
    return {
      warning,
      dismiss,
      idOf: (n: number) => warning.mock.calls[n][1].id as string,
    };
  };

  it("shows each retry as a new toast and closes the one before it after sonner has added it", () => {
    vi.useFakeTimers();
    try {
      const a = api();
      const toasts = createRetryToasts(a);
      toasts.show("first", 1.1);
      expect(a.dismiss).not.toHaveBeenCalled();
      toasts.show("second", 4);
      expect(a.idOf(0)).toMatch(/^model-retry-\d+$/);
      expect(a.idOf(1)).not.toBe(a.idOf(0));
      // Queued behind sonner's own 0 ms add, not sent in the same tick.
      expect(a.dismiss).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(a.dismiss).toHaveBeenCalledWith(a.idOf(0));
      expect(a.warning.mock.calls[1][1]).toMatchObject({
        duration: 8000,
        closeButton: true,
      });
      // Sonner then reports the first toast closed; that changes nothing.
      a.warning.mock.calls[0][1].onDismiss();
      toasts.dismiss();
      expect(a.dismiss).toHaveBeenLastCalledWith(a.idOf(1));
      toasts.dismiss();
      expect(a.dismiss).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the current toast at once when the run ends", () => {
    const a = api();
    const toasts = createRetryToasts(a);
    toasts.show("only", 1);
    toasts.dismiss();
    expect(a.dismiss).toHaveBeenCalledWith(a.idOf(0));
  });

  it("never reuses an id, not even across chat instances", () => {
    const a = api();
    const toasts = createRetryToasts(a);
    toasts.show("first", 1);
    toasts.dismiss();
    toasts.show("second", 1);
    const b = api();
    createRetryToasts(b).show("third", 1);
    expect(new Set([a.idOf(0), a.idOf(1), b.idOf(0)]).size).toBe(3);
  });

  it("has nothing to close once the timer or the user closed the toast", () => {
    const a = api();
    const toasts = createRetryToasts(a);
    toasts.show("first", 1);
    a.warning.mock.calls[0][1].onAutoClose();
    toasts.dismiss();
    toasts.show("second", 1);
    a.warning.mock.calls[1][1].onDismiss();
    toasts.dismiss();
    expect(a.dismiss).not.toHaveBeenCalled();
    // A late callback from an old toast does not forget the current one.
    toasts.show("third", 1);
    a.warning.mock.calls[0][1].onDismiss();
    toasts.dismiss();
    expect(a.dismiss).toHaveBeenCalledWith(a.idOf(2));
  });
});
