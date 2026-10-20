// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadThreadWorkflows, saveThreadWorkflows } from "./workflowStore";
import {
  applySubagentEvent,
  parseSubagentEvent,
  type SubagentEvent,
  type WorkflowDispatch,
  type WorkflowMap,
} from "./dynamicWorkflow";

const STORAGE_KEY = "evoscientist-dynamic-workflows";

function dispatch(
  id: string,
  status: WorkflowDispatch["status"]
): WorkflowDispatch {
  return {
    id,
    label: `label ${id}`,
    subagentType: "task",
    description: "",
    status,
    startedAt: 0,
    durationMs: status === "running" ? undefined : 10,
  };
}

function event(raw: Record<string, unknown>): SubagentEvent {
  const parsed = parseSubagentEvent({
    type: "subagent",
    eval_id: "call_1",
    ...raw,
  });
  if (!parsed) throw new Error("not a subagent event");
  return parsed;
}

function mapWith(dispatches: WorkflowDispatch[]): WorkflowMap {
  return { call_1: { evalId: "call_1", dispatches, updatedAt: 1 } };
}

describe("workflowStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips terminal dispatches per thread", () => {
    saveThreadWorkflows(
      "t1",
      mapWith([dispatch("a", "done"), dispatch("b", "error")])
    );
    const loaded = loadThreadWorkflows("t1");
    expect(loaded["call_1"].dispatches.map((d) => d.id)).toEqual(["a", "b"]);
    expect(loadThreadWorkflows("t2")).toEqual({});
  });

  it("strips running rows and skips evals with no terminal row", () => {
    saveThreadWorkflows(
      "t1",
      mapWith([dispatch("a", "done"), dispatch("b", "running")])
    );
    expect(
      loadThreadWorkflows("t1")["call_1"].dispatches.map((d) => d.id)
    ).toEqual(["a"]);
    saveThreadWorkflows("t2", mapWith([dispatch("x", "running")]));
    expect(loadThreadWorkflows("t2")).toEqual({});
  });

  it("caps dispatches per eval at 200 keeping the newest", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      dispatch(`d${i}`, "done")
    );
    saveThreadWorkflows("t1", mapWith(many));
    const rows = loadThreadWorkflows("t1")["call_1"].dispatches;
    expect(rows).toHaveLength(200);
    expect(rows[0].id).toBe("d50");
    expect(rows[199].id).toBe("d249");
  });

  it("evicts least-recently-updated threads beyond 20", () => {
    for (let i = 0; i < 21; i++) {
      saveThreadWorkflows(`t${i}`, mapWith([dispatch("a", "done")]));
    }
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(Object.keys(stored)).toHaveLength(20);
  });

  it("treats corrupt storage as empty", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadThreadWorkflows("t1")).toEqual({});
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { evals: { bad: 42 } } })
    );
    expect(loadThreadWorkflows("t1")).toEqual({});
  });

  it("rejects malformed dispatch fields before they can reach the UI", () => {
    const malformed = {
      evalId: "call_1",
      updatedAt: 1,
      dispatches: [
        {
          id: "bad",
          label: "bad",
          subagentType: "task",
          status: "not-a-real-status",
          startedAt: 0,
        },
      ],
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { updatedAt: 1, evals: { call_1: malformed } } })
    );
    expect(loadThreadWorkflows("t1")).toEqual({});
  });

  // Written before a blank type fell back to "subagent".
  it("loads a dispatch stored with a blank type as subagent", () => {
    const blank = { ...dispatch("a", "done"), subagentType: "" };
    const invisible = {
      ...dispatch("b", "done"),
      subagentType: String.fromCharCode(0x200b, 0x200b),
    };
    const typed = { ...dispatch("c", "done"), subagentType: "research-agent" };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        t1: { updatedAt: 1, evals: mapWith([blank, invisible, typed]) },
      })
    );

    expect(loadThreadWorkflows("t1")["call_1"].dispatches).toEqual([
      { ...blank, subagentType: "subagent" },
      { ...invisible, subagentType: "subagent" },
      typed,
    ]);
  });

  // Saved rows are named again on load, which must not change them.
  it.each([
    [
      "cut after a space",
      { subagent_type: "a".repeat(59) + " b", label: "a".repeat(199) + " b" },
      { subagentType: "a".repeat(59), label: "a".repeat(199) },
    ],
    [
      "typed with half a character before a space",
      { subagent_type: String.fromCharCode(0xd800) + " " },
      { subagentType: "subagent" },
    ],
  ])("loads a dispatch %s as it was saved", (_label, fields, expected) => {
    const started = applySubagentEvent(
      {},
      event({ phase: "start", id: "d1", ...fields }),
      1
    );
    const done = applySubagentEvent(
      started,
      event({ phase: "complete", id: "d1", duration_ms: 5 }),
      2
    );
    expect(done["call_1"].dispatches[0]).toMatchObject(expected);
    saveThreadWorkflows("t1", done);

    expect(loadThreadWorkflows("t1")).toEqual(done);
  });

  // Main kept invisible characters at the start of a label.
  it("loads a label stored with an invisible start the same way twice", () => {
    const stored = {
      ...dispatch("a", "done"),
      label: String.fromCharCode(0x200b) + "Review",
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { updatedAt: 1, evals: mapWith([stored]) } })
    );
    const loaded = loadThreadWorkflows("t1");
    expect(loaded["call_1"].dispatches[0].label).toBe("Review");

    saveThreadWorkflows("t1", loaded);
    expect(loadThreadWorkflows("t1")).toEqual(loaded);
  });

  // Two long ids that differ only at the end got one label after a reload.
  it("loads dispatches labelled by long ids as they were saved", () => {
    let map: WorkflowMap = {};
    for (const id of ["x".repeat(10_000) + "A", "x".repeat(10_000) + "B"]) {
      map = applySubagentEvent(map, event({ phase: "start", id }), 1);
      map = applySubagentEvent(
        map,
        event({ phase: "complete", id, duration_ms: 5 }),
        2
      );
    }
    saveThreadWorkflows("t1", map);

    expect(loadThreadWorkflows("t1")).toEqual(map);
  });

  // Written before a label with nothing to show fell back to the next name.
  it("loads a dispatch stored with a blank label under its first name that shows", () => {
    const byDescription = {
      ...dispatch("a", "done"),
      label: "",
      description: "Review idea 3",
    };
    const byId = {
      ...dispatch("b", "done"),
      label: String.fromCharCode(0x200b),
    };
    const byType = {
      ...dispatch("   ", "done"),
      label: "   ",
      subagentType: "research-agent",
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        t1: { updatedAt: 1, evals: mapWith([byDescription, byId, byType]) },
      })
    );

    expect(loadThreadWorkflows("t1")["call_1"].dispatches).toEqual([
      { ...byDescription, label: "Review idea 3" },
      { ...byId, label: "b" },
      { ...byType, label: "research-agent" },
    ]);
  });

  it("caps oversized data even when storage was written externally", () => {
    const oversized = mapWith(
      Array.from({ length: 250 }, (_, i) => dispatch(`external-${i}`, "done"))
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ t1: { updatedAt: 1, evals: oversized } })
    );
    const rows = loadThreadWorkflows("t1")["call_1"].dispatches;
    expect(rows).toHaveLength(200);
    expect(rows[0].id).toBe("external-50");
  });

  it("evicts the least-recently-updated thread on tie, never the just-saved one", () => {
    for (let i = 0; i < 21; i++) {
      saveThreadWorkflows(`t${i}`, mapWith([dispatch("a", "done")]));
    }
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string);
    expect(Object.keys(stored)).toHaveLength(20);
    expect(stored["t20"]).toBeDefined();
    expect(stored["t0"]).toBeUndefined();
  });

  it("removes a thread entry when a save yields nothing persistable", () => {
    saveThreadWorkflows("t1", mapWith([dispatch("a", "done")]));
    expect(loadThreadWorkflows("t1")["call_1"]).toBeDefined();
    saveThreadWorkflows("t1", mapWith([dispatch("a", "running")]));
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) as string)["t1"]
    ).toBeUndefined();
  });
});
