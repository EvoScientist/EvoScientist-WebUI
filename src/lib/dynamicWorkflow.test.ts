import { describe, expect, it } from "vitest";
import {
  aggregateWorkflows,
  applySubagentEvent,
  finalizeRunning,
  formatWorkflowTiming,
  mergeWorkflowMaps,
  parseSubagentEvent,
  sanitizeLine,
  sortWorkflowEvals,
  workflowCounts,
  workflowElapsedMs,
  type SubagentEvent,
  type WorkflowMap,
} from "./dynamicWorkflow";

const startRaw = {
  type: "subagent",
  phase: "start",
  id: "ptc_task_aaaa1111",
  subagent_type: "general-purpose",
  label: "battle: idea-3 vs idea-7",
  description: "Run an ELO battle between idea 3 and idea 7",
  eval_id: "call_eval_1",
};
const zwsp = String.fromCharCode(0x200b);

function apply(map: WorkflowMap, raw: unknown, now: number): WorkflowMap {
  const event = parseSubagentEvent(raw);
  expect(event).not.toBeNull();
  return applySubagentEvent(map, event as SubagentEvent, now);
}

describe("parseSubagentEvent", () => {
  // A type with nothing visible showed as a blank badge.
  it.each([
    ["only spaces", "   "],
    ["only line breaks and tabs", "\n\t"],
    ["only control and bidi characters", String.fromCharCode(7, 0x202e)],
    ["only zero-width spaces", zwsp + zwsp],
    [
      "only a word joiner, a soft hyphen and a filler",
      String.fromCharCode(0x2060, 0xad, 0x3164),
    ],
    ["only blank braille cells", String.fromCharCode(0x2800, 0x2800)],
    ["missing", undefined],
    ["not text", 42],
  ])("falls back to subagent for a type that is %s", (_label, type) => {
    expect(
      parseSubagentEvent({ ...startRaw, subagent_type: type })
    ).toMatchObject({ subagentType: "subagent" });
  });

  it("drops invisible characters before a type, past the length limit", () => {
    const type = zwsp.repeat(60) + "research-agent";
    expect(
      parseSubagentEvent({ ...startRaw, subagent_type: type })
    ).toMatchObject({ subagentType: "research-agent" });
  });

  // Each of these draws differently without its joiner or selector.
  it.each([
    ["a joiner", String.fromCodePoint(0x1f469, 0x200d, 0x1f52c) + "-scientist"],
    ["a variation selector", String.fromCodePoint(0x270d, 0xfe0f) + "-writer"],
    [
      "a non-joiner",
      String.fromCharCode(0x645, 0x6cc, 0x200c, 0x631, 0x648, 0x62f),
    ],
    [
      "the tag characters of a flag",
      "scotland-" +
        String.fromCodePoint(
          0x1f3f4,
          0xe0067,
          0xe0062,
          0xe0073,
          0xe0063,
          0xe0074,
          0xe007f
        ),
    ],
  ])("keeps %s inside a type", (_label, type) => {
    expect(
      parseSubagentEvent({ ...startRaw, subagent_type: type })
    ).toMatchObject({ subagentType: type });
  });

  // Cut between the halves of an emoji, the text ended in a broken character.
  const emoji = String.fromCodePoint(0x1f600);
  it.each([
    [
      "a type",
      { subagent_type: zwsp + "a".repeat(59) + emoji },
      { subagentType: "a".repeat(59) },
    ],
    ["a label", { label: "a".repeat(199) + emoji }, { label: "a".repeat(199) }],
    [
      "a label taken from the description",
      { label: undefined, description: "a".repeat(59) + emoji + " more" },
      { label: "a".repeat(59) },
    ],
  ])(
    "does not cut a character in half at the end of %s",
    (_label, fields, expected) => {
      expect(parseSubagentEvent({ ...startRaw, ...fields })).toMatchObject(
        expected
      );
    }
  );

  // Cut right after a space, the text kept it, and loading dropped it.
  it.each([
    [
      "a type",
      { subagent_type: "a".repeat(59) + " b" },
      { subagentType: "a".repeat(59) },
    ],
    ["a label", { label: "a".repeat(199) + " b" }, { label: "a".repeat(199) }],
  ])("ends %s cut after a space without it", (_label, fields, expected) => {
    expect(parseSubagentEvent({ ...startRaw, ...fields })).toMatchObject(
      expected
    );
  });

  it.each([
    [
      "an emoji that ends at the limit",
      "a".repeat(58) + emoji,
      "a".repeat(58) + emoji,
    ],
    ["an emoji past the limit", "a".repeat(60) + emoji, "a".repeat(60)],
    ["a lone first half", "abc" + String.fromCharCode(0xd83d), "abc"],
  ])(
    "cuts a type with %s on a character boundary",
    (_label, type, expected) => {
      expect(
        parseSubagentEvent({ ...startRaw, subagent_type: type })
      ).toMatchObject({ subagentType: expected });
    }
  );

  // Only a first half with nothing after it goes; a cut never leaves a
  // second half alone.
  it.each([
    ["the highest first half", "ab" + String.fromCharCode(0xdbff), "ab"],
    [
      "a first half after a whole emoji",
      "ab" + emoji + String.fromCharCode(0xd83d),
      "ab" + emoji,
    ],
    [
      "a lone second half, which stays",
      "ab" + String.fromCharCode(0xde00),
      "ab" + String.fromCharCode(0xde00),
    ],
  ])("ends a type with %s", (_label, type, expected) => {
    expect(
      parseSubagentEvent({ ...startRaw, subagent_type: type })
    ).toMatchObject({ subagentType: expected });
  });

  // Two long ids that differ only at the end showed the same label.
  it("labels a dispatch by its whole id", () => {
    const id = "x".repeat(10_000) + "A";
    const raw = { type: "subagent", phase: "start", id, eval_id: "e1" };
    expect(parseSubagentEvent(raw)).toMatchObject({ label: id });
  });

  it("labels a dispatch by its id when its label and description show nothing", () => {
    expect(
      parseSubagentEvent({
        ...startRaw,
        label: zwsp,
        description: zwsp + " " + String.fromCharCode(0x2800),
      })
    ).toMatchObject({ label: "ptc_task_aaaa1111", description: "" });
  });

  it("labels a dispatch by its description past an invisible start", () => {
    const description = zwsp.repeat(80) + " Review idea 3";
    const raw = { ...startRaw, label: undefined, description };
    expect(parseSubagentEvent(raw)).toMatchObject({
      label: "Review idea 3",
      description: "Review idea 3",
    });
  });

  it("labels a dispatch by its id without the id's controls", () => {
    const id = "ptc" + String.fromCharCode(0x202e) + "_x";
    const raw = { type: "subagent", phase: "start", id, eval_id: "e1" };
    expect(parseSubagentEvent(raw)).toMatchObject({ id, label: "ptc _x" });
  });

  // An id is only matched, so one that shows nothing still counts.
  it.each([
    ["spaces", "   "],
    ["a zero-width space", zwsp],
    ["a bidi control", String.fromCharCode(0x202e)],
  ])("labels a dispatch whose id is only %s by its type", (_label, id) => {
    const raw = {
      type: "subagent",
      phase: "start",
      id,
      subagent_type: "research-agent",
      eval_id: "e1",
    };
    expect(parseSubagentEvent(raw)).toMatchObject({
      id,
      label: "research-agent",
    });
  });

  it("parses a start event", () => {
    const event = parseSubagentEvent(startRaw);
    expect(event).toEqual({
      phase: "start",
      id: "ptc_task_aaaa1111",
      evalId: "call_eval_1",
      subagentType: "general-purpose",
      label: "battle: idea-3 vs idea-7",
      description: "Run an ELO battle between idea 3 and idea 7",
    });
  });

  it("defaults evalId to empty string when eval_id is absent", () => {
    const { eval_id: _omit, ...noEval } = startRaw;
    const event = parseSubagentEvent(noEval);
    expect(event?.evalId).toBe("");
  });

  it("falls back to compressed description when label is missing", () => {
    const event = parseSubagentEvent({
      ...startRaw,
      label: undefined,
      description: "  line one\nline\ttwo  ",
    });
    expect(event?.phase).toBe("start");
    if (event?.phase === "start") expect(event.label).toBe("line one line two");
  });

  it("rejects non-subagent, missing-id, and unknown-phase payloads", () => {
    expect(parseSubagentEvent(null)).toBeNull();
    expect(parseSubagentEvent({ type: "other" })).toBeNull();
    expect(parseSubagentEvent({ ...startRaw, id: "" })).toBeNull();
    expect(parseSubagentEvent({ ...startRaw, phase: "weird" })).toBeNull();
  });

  it("strips control and bidi characters from untrusted strings", () => {
    const event = parseSubagentEvent({
      ...startRaw,
      label: "evil‮ label here",
    });
    if (event?.phase === "start") expect(event.label).toBe("evil label here");
  });
});

describe("applySubagentEvent", () => {
  it("creates a running dispatch on start, grouped by evalId", () => {
    const map = apply({}, startRaw, 1000);
    const evalData = map["call_eval_1"];
    expect(evalData.dispatches).toHaveLength(1);
    expect(evalData.dispatches[0]).toMatchObject({
      id: "ptc_task_aaaa1111",
      status: "running",
      startedAt: 1000,
    });
  });

  it("marks done with durationMs on complete", () => {
    let map = apply({}, startRaw, 1000);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 12345,
        eval_id: "call_eval_1",
      },
      13000
    );
    expect(map["call_eval_1"].dispatches[0]).toMatchObject({
      status: "done",
      durationMs: 12345,
    });
  });

  it("marks error with message on error", () => {
    let map = apply({}, startRaw, 1000);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "error",
        id: "ptc_task_aaaa1111",
        duration_ms: 500,
        error: "boom",
        eval_id: "call_eval_1",
      },
      2000
    );
    expect(map["call_eval_1"].dispatches[0]).toMatchObject({
      status: "error",
      error: "boom",
    });
  });

  it("keeps a fallback type through completion", () => {
    const started = apply({}, { ...startRaw, subagent_type: "   " }, 1);
    const done = apply(
      started,
      {
        type: "subagent",
        phase: "complete",
        id: startRaw.id,
        duration_ms: 5,
        eval_id: startRaw.eval_id,
      },
      2
    );
    expect(done[startRaw.eval_id].dispatches[0]).toMatchObject({
      subagentType: "subagent",
      status: "done",
    });
  });

  it("matches a labelled dispatch whose id starts with nothing to see", () => {
    const id = zwsp.repeat(200) + "a";
    const started = apply({}, { ...startRaw, id, label: "Review" }, 1);
    const done = apply(
      started,
      {
        type: "subagent",
        phase: "complete",
        id,
        duration_ms: 5,
        eval_id: startRaw.eval_id,
      },
      2
    );
    expect(done[startRaw.eval_id].dispatches).toEqual([
      expect.objectContaining({ id, label: "Review", status: "done" }),
    ]);
  });

  it("labels an orphan error whose id shows nothing by its type", () => {
    const errored = apply(
      {},
      {
        type: "subagent",
        phase: "error",
        id: "   ",
        error: "boom",
        eval_id: "e1",
      },
      1
    );
    expect(errored["e1"].dispatches[0]).toMatchObject({
      id: "   ",
      label: "subagent",
      subagentType: "subagent",
    });
  });

  it("labels an orphan error by its id without the id's controls", () => {
    const id = "ptc" + String.fromCharCode(0x202e) + "_y";
    const errored = apply(
      {},
      { type: "subagent", phase: "error", id, error: "boom", eval_id: "e1" },
      1
    );
    expect(errored["e1"].dispatches[0]).toMatchObject({
      id,
      label: "ptc _y",
      subagentType: "subagent",
    });
  });

  it("drops an orphan complete but adopts an orphan error", () => {
    const complete = apply(
      {},
      {
        type: "subagent",
        phase: "complete",
        id: "ghost",
        duration_ms: 5,
        eval_id: "e1",
      },
      1
    );
    expect(complete).toEqual({});
    const errored = apply(
      {},
      {
        type: "subagent",
        phase: "error",
        id: "ghost",
        duration_ms: 5,
        error: "lost start",
        eval_id: "e1",
      },
      1
    );
    expect(errored["e1"].dispatches[0]).toMatchObject({
      id: "ghost",
      status: "error",
      error: "lost start",
    });
  });

  it("is idempotent: terminal rows are never downgraded by replayed events", () => {
    let map = apply({}, startRaw, 1000);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 100,
        eval_id: "call_eval_1",
      },
      1100
    );
    const replayedStart = apply(map, startRaw, 1200);
    expect(replayedStart).toBe(map);
    const replayedComplete = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 999,
        eval_id: "call_eval_1",
      },
      1300
    );
    expect(replayedComplete).toBe(map);
  });

  it("keeps arrival order across mixed dispatches", () => {
    let map = apply({}, startRaw, 1);
    map = apply(
      map,
      { ...startRaw, id: "ptc_task_bbbb2222", label: "second" },
      2
    );
    expect(map["call_eval_1"].dispatches.map((d) => d.id)).toEqual([
      "ptc_task_aaaa1111",
      "ptc_task_bbbb2222",
    ]);
  });
});

describe("finalizeRunning", () => {
  it("cancels running rows, freezes duration, and returns same ref when nothing runs", () => {
    const map = apply({}, startRaw, 1000);
    const finalized = finalizeRunning(map, 4000);
    expect(finalized["call_eval_1"].dispatches[0]).toMatchObject({
      status: "cancelled",
      durationMs: 3000,
    });
    expect(finalizeRunning(finalized, 5000)).toBe(finalized);
  });
});

describe("mergeWorkflowMaps", () => {
  it("prefers terminal rows and appends live-only dispatches", () => {
    const stored = apply(
      apply({}, startRaw, 1),
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 10,
        eval_id: "call_eval_1",
      },
      2
    );
    const live = apply(
      apply({}, startRaw, 5),
      { ...startRaw, id: "ptc_task_cccc3333", label: "live only" },
      6
    );
    const merged = mergeWorkflowMaps(stored, live);
    const rows = merged["call_eval_1"].dispatches;
    expect(rows.map((d) => d.id)).toEqual([
      "ptc_task_aaaa1111",
      "ptc_task_cccc3333",
    ]);
    expect(rows[0].status).toBe("done");
    expect(rows[1].status).toBe("running");
  });
});

describe("counts and timing", () => {
  it("counts statuses and formats stable-width timing", () => {
    let map = apply({}, startRaw, 0);
    map = apply(map, { ...startRaw, id: "d2" }, 0);
    map = apply(map, { ...startRaw, id: "d3" }, 0);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "d2",
        duration_ms: 2000,
        eval_id: "call_eval_1",
      },
      2000
    );
    map = apply(
      map,
      {
        type: "subagent",
        phase: "error",
        id: "d3",
        duration_ms: 3000,
        error: "x",
        eval_id: "call_eval_1",
      },
      3000
    );
    expect(workflowCounts(map["call_eval_1"])).toEqual({
      total: 3,
      finished: 2,
      failed: 1,
      cancelled: 0,
      running: 1,
    });
    expect(workflowElapsedMs(map["call_eval_1"], 10000)).toBe(10000);
    expect(formatWorkflowTiming(4000)).toBe("4.0s");
    expect(formatWorkflowTiming(4230)).toBe("4.2s");
    expect(formatWorkflowTiming(95000)).toBe("1m 35s");
  });

  it("freezes workflow elapsed at last finish once all rows are terminal", () => {
    let map = apply({}, startRaw, 0);
    map = apply(
      map,
      {
        type: "subagent",
        phase: "complete",
        id: "ptc_task_aaaa1111",
        duration_ms: 7000,
        eval_id: "call_eval_1",
      },
      7000
    );
    expect(workflowElapsedMs(map["call_eval_1"], 99999)).toBe(7000);
  });
});

describe("sanitizeLine", () => {
  it("flattens newlines, strips controls, and bounds length", () => {
    expect(sanitizeLine("a\nb", 10)).toBe("a b");
    expect(sanitizeLine("x".repeat(300), 10)).toHaveLength(10);
  });

  // Stored rows are cleaned again on load, which must not change them.
  it.each([
    ["a cut after a space", "a".repeat(9) + " b"],
    ["a cut inside an emoji", "a".repeat(9) + String.fromCodePoint(0x1f600)],
    ["blanks at both ends", zwsp + " text " + zwsp],
    [
      "half a character before a space",
      "ab" + String.fromCharCode(0xd83d) + " ",
    ],
  ])("gives the same text when run again on %s", (_label, text) => {
    const once = sanitizeLine(text, 10);
    expect(sanitizeLine(once, 10)).toBe(once);
  });
});

describe("aggregateWorkflows and sortWorkflowEvals", () => {
  const doneDispatch = {
    id: "d1",
    label: "battle one",
    subagentType: "task",
    description: "",
    status: "done" as const,
    startedAt: 100,
    durationMs: 500,
  };
  const runningDispatch = {
    id: "d2",
    label: "refine two",
    subagentType: "task",
    description: "",
    status: "running" as const,
    startedAt: 2000,
  };
  const cancelledDispatch = {
    id: "d3",
    label: "old three",
    subagentType: "task",
    description: "",
    status: "cancelled" as const,
    startedAt: 50,
    durationMs: 10,
  };

  it("aggregates counts, running label, and active eval across evals", () => {
    const map: WorkflowMap = {
      call_a: {
        evalId: "call_a",
        dispatches: [doneDispatch, cancelledDispatch],
        updatedAt: 500,
      },
      call_b: {
        evalId: "call_b",
        dispatches: [runningDispatch],
        updatedAt: 2000,
      },
      call_empty: { evalId: "call_empty", dispatches: [], updatedAt: 9999 },
    };
    expect(aggregateWorkflows(map)).toEqual({
      phaseCount: 2,
      total: 3,
      finished: 2,
      failed: 0,
      cancelled: 1,
      running: 1,
      runningLabel: "refine two",
      activeEvalId: "call_b",
    });
  });

  it("falls back to the newest eval when nothing runs", () => {
    const map: WorkflowMap = {
      call_a: { evalId: "call_a", dispatches: [doneDispatch], updatedAt: 500 },
      call_b: {
        evalId: "call_b",
        dispatches: [cancelledDispatch],
        updatedAt: 800,
      },
    };
    const agg = aggregateWorkflows(map);
    expect(agg.running).toBe(0);
    expect(agg.runningLabel).toBeNull();
    expect(agg.activeEvalId).toBe("call_b");
  });

  it("returns an empty aggregate for an empty map", () => {
    expect(aggregateWorkflows({})).toEqual({
      phaseCount: 0,
      total: 0,
      finished: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      runningLabel: null,
      activeEvalId: null,
    });
  });

  it("sorts evals by earliest dispatch start and skips empty evals", () => {
    const map: WorkflowMap = {
      late: { evalId: "late", dispatches: [runningDispatch], updatedAt: 1 },
      early: {
        evalId: "early",
        dispatches: [cancelledDispatch, doneDispatch],
        updatedAt: 2,
      },
      empty: { evalId: "empty", dispatches: [], updatedAt: 3 },
    };
    expect(sortWorkflowEvals(map).map((e) => e.evalId)).toEqual([
      "early",
      "late",
    ]);
  });
});
