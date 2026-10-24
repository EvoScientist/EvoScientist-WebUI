import { describe, expect, it } from "vitest";
import { goalEventKey, goalEventNotice, parseGoalEvent } from "./goalEvents";

describe("parseGoalEvent", () => {
  it("reads goal_state", () => {
    expect(
      parseGoalEvent({
        type: "goal_state",
        change: "blocked",
        status: "blocked",
        note: "Need input.",
      })
    ).toEqual({
      type: "goal_state",
      change: "blocked",
      status: "blocked",
      note: "Need input.",
    });
  });

  it("reads an accepted goal with its criteria", () => {
    expect(
      parseGoalEvent({
        type: "goal_state",
        change: "accepted",
        status: "active",
        objective: "Write hello",
        criteria: "- one",
        message: "Write hello",
        unreviewed: true,
      })
    ).toEqual({
      type: "goal_state",
      change: "accepted",
      status: "active",
      criteria: "- one",
      unreviewed: true,
    });
  });

  it("reads the grading events", () => {
    expect(
      parseGoalEvent({
        type: "rubric_evaluation_start",
        grading_run_id: "g1",
        iteration: 0,
      })
    ).toEqual({
      type: "rubric_evaluation_start",
      gradingRunId: "g1",
      iteration: 0,
    });
    expect(
      parseGoalEvent({
        type: "rubric_evaluation_end",
        grading_run_id: "g1",
        iteration: 1,
        result: "needs_revision",
        explanation: "One criterion fails.",
        criteria: [],
        unverified: false,
      })
    ).toEqual({
      type: "rubric_evaluation_end",
      gradingRunId: "g1",
      iteration: 1,
      result: "needs_revision",
      explanation: "One criterion fails.",
    });
    expect(
      parseGoalEvent({
        type: "rubric_evaluation_deferred",
        tasks: 1,
        processes: 0,
      })
    ).toEqual({
      type: "rubric_evaluation_deferred",
      tasks: 1,
      processes: 0,
    });
  });

  it.each([
    [{ evoscientist: { kind: "fallback_notice" } }],
    [{ type: "subagent", event: "start" }],
    [{ type: "model_call", phase: "start" }],
    [{ type: "goal_state" }],
    [{ type: "goal_state", change: "bogus" }],
    [
      {
        type: "rubric_evaluation_end",
        grading_run_id: "g1",
        iteration: 0,
        result: "bogus",
        explanation: "",
      },
    ],
    [{ type: "rubric_evaluation_start", iteration: 0 }],
    [null],
    ["goal_state"],
  ])("ignores %j", (data) => {
    expect(parseGoalEvent(data)).toBeNull();
  });
});

describe("goalEventNotice", () => {
  const notice = (data: Record<string, unknown>) => {
    const event = parseGoalEvent(data);
    if (!event) throw new Error(`not an event: ${JSON.stringify(data)}`);
    return goalEventNotice(event);
  };

  // The CLI's goal_event_lines (stream/display.py), word for word.
  it.each([
    [{ change: "accepted" }, "success", "Goal accepted."],
    [
      { change: "accepted", unreviewed: true },
      "warning",
      "Goal accepted without review (auto mode).",
    ],
    [{ change: "amended" }, "success", "Goal amended."],
    [
      { change: "amended", unreviewed: true },
      "warning",
      "Goal amended without review (auto mode).",
    ],
    [{ change: "cancelled" }, "warning", "Goal proposal cancelled."],
    [
      { change: "failed", note: "The drafter returned no list of criteria." },
      "error",
      "Goal request failed: The drafter returned no list of criteria.",
    ],
    [{ change: "failed" }, "error", "Goal request failed."],
    [
      { change: "ignored", note: "The goal changed; nothing was done." },
      "warning",
      "Nothing was changed: The goal changed; nothing was done.",
    ],
    [{ change: "paused" }, "warning", "Goal paused."],
    [{ change: "resumed" }, "success", "Goal resumed."],
    [{ change: "cleared" }, "warning", "Goal cleared."],
    [
      { change: "cleared", note: "A /rubric checklist replaced it." },
      "warning",
      "Goal cleared. A /rubric checklist replaced it.",
    ],
    [
      { change: "blocked", note: "Need  the\nuser's input." },
      "warning",
      "Goal blocked: Need the user's input.",
    ],
    [
      { change: "complete", note: "Acceptance criteria satisfied." },
      "success",
      "Goal complete. Acceptance criteria satisfied.",
    ],
    [
      { change: "unmet" },
      "info",
      "The goal stays active: send a message to continue, /goal amend to change it, /goal clear to drop it.",
    ],
  ])("goal_state %j is %s %j", (fields, level, text) => {
    expect(notice({ type: "goal_state", ...fields })).toEqual({ level, text });
  });

  it("shows the start of a long note", () => {
    expect(
      notice({ type: "goal_state", change: "blocked", note: "x".repeat(300) })
        ?.text
    ).toBe(`Goal blocked: ${"x".repeat(237)}...`);
  });

  it.each(["drafting", "unblocked"])("has nothing to say for %s", (change) => {
    expect(notice({ type: "goal_state", change })).toBeNull();
  });

  it.each([
    ["needs_revision", "warning", "Acceptance criteria not yet satisfied"],
    [
      "max_iterations_reached",
      "warning",
      "Acceptance criteria not satisfied (pass limit reached)",
    ],
    ["failed", "error", "Rubric cannot be evaluated"],
    ["grader_error", "error", "Acceptance criteria check failed"],
  ])("grading result %s is %s %j", (result, level, text) => {
    expect(
      notice({
        type: "rubric_evaluation_end",
        grading_run_id: "g1",
        iteration: 0,
        result,
        explanation: "",
      })
    ).toEqual({ level, text });
  });

  // rubric_result_lines puts the explanation after the label; a toast
  // shortens it like a note.
  it("adds the grader's explanation after the result", () => {
    const end = (result: string, explanation: string) =>
      notice({
        type: "rubric_evaluation_end",
        grading_run_id: "g1",
        iteration: 0,
        result,
        explanation,
      });
    expect(end("needs_revision", "  The file\n is missing.  ")).toEqual({
      level: "warning",
      text: "Acceptance criteria not yet satisfied: The file is missing.",
    });
    expect(end("grader_error", "x".repeat(300))).toEqual({
      level: "error",
      text: `Acceptance criteria check failed: ${"x".repeat(237)}...`,
    });
    expect(end("satisfied", "All good.")).toBeNull();
  });

  it("leaves a satisfied verdict and a grading start to the goal's own notice", () => {
    expect(
      notice({
        type: "rubric_evaluation_end",
        grading_run_id: "g1",
        iteration: 0,
        result: "satisfied",
        explanation: "",
      })
    ).toBeNull();
    expect(
      notice({
        type: "rubric_evaluation_start",
        grading_run_id: "g1",
        iteration: 0,
      })
    ).toBeNull();
  });

  // The CLI's rubric_deferred_text, in its yellow (a warning, as the other
  // yellow lines are).
  it.each([
    [1, 0, "Acceptance check deferred: 1 background task still running"],
    [2, 0, "Acceptance check deferred: 2 background tasks still running"],
    [0, 1, "Acceptance check deferred: 1 background process still running"],
    [
      1,
      2,
      "Acceptance check deferred: 1 background task and 2 processes still running",
    ],
    [0, 0, "Acceptance check deferred: background work still running"],
  ])("deferred with %d tasks and %d processes", (tasks, processes, text) => {
    expect(
      notice({ type: "rubric_evaluation_deferred", tasks, processes })
    ).toEqual({ level: "warning", text });
  });
});

describe("goalEventKey", () => {
  it("is the same for the same event and differs by iteration", () => {
    const start = (iteration: number) =>
      parseGoalEvent({
        type: "rubric_evaluation_start",
        grading_run_id: "g1",
        iteration,
      })!;
    expect(goalEventKey(start(0))).toBe(goalEventKey(start(0)));
    expect(goalEventKey(start(0))).not.toBe(goalEventKey(start(1)));
    const blocked = parseGoalEvent({
      type: "goal_state",
      change: "blocked",
      note: "a",
    })!;
    const unblocked = parseGoalEvent({
      type: "goal_state",
      change: "unblocked",
    })!;
    expect(goalEventKey(blocked)).not.toBe(goalEventKey(unblocked));
  });
});
