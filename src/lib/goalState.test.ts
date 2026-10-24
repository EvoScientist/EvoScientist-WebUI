import { describe, expect, it } from "vitest";
import { lastRubricVerdict, threadGoal } from "./goalState";

const goal = {
  objective: "Write hello into probe.txt",
  status: "active",
  note: null,
  evidence: null,
  rubric_id: "goal:abc",
  start: "m1",
};
const sticky = { text: "- The file exists\n- It says hello", id: "goal:abc" };

describe("threadGoal", () => {
  it("reads the goal when the thread's checklist is its own", () => {
    expect(threadGoal({ _goal: goal, _sticky_rubric: sticky })).toEqual({
      objective: "Write hello into probe.txt",
      status: "active",
      note: null,
      rubricId: "goal:abc",
      criteria: "- The file exists\n- It says hello",
    });
  });

  it("keeps the note of a blocked goal", () => {
    expect(
      threadGoal({
        _goal: { ...goal, status: "blocked", note: "Need the user's input." },
        _sticky_rubric: sticky,
      })
    ).toMatchObject({ status: "blocked", note: "Need the user's input." });
  });

  it("is null when the thread's checklist is another one", () => {
    expect(
      threadGoal({ _goal: goal, _sticky_rubric: { ...sticky, id: "rubric:7" } })
    ).toBeNull();
  });

  it.each([
    [{ _goal: goal }],
    [{ _sticky_rubric: sticky }],
    [{ _goal: { ...goal, status: "done" }, _sticky_rubric: sticky }],
    [{ _goal: { ...goal, objective: 3 }, _sticky_rubric: sticky }],
    [{}],
    [null],
    [undefined],
  ])("is null for %j", (values) => {
    expect(threadGoal(values)).toBeNull();
  });
});

describe("lastRubricVerdict", () => {
  it("takes the last evaluation", () => {
    expect(
      lastRubricVerdict({
        _rubric_evaluations: [
          {
            grading_run_id: "g1",
            iteration: 0,
            result: "needs_revision",
            explanation: "Not yet.",
            criteria: [],
          },
          {
            grading_run_id: "g1",
            iteration: 1,
            result: "satisfied",
            explanation: "Done.",
            criteria: [],
          },
        ],
      })
    ).toEqual({ result: "satisfied", explanation: "Done.", iteration: 1 });
  });

  it.each([
    [{}],
    [{ _rubric_evaluations: [] }],
    [
      {
        _rubric_evaluations: [
          { iteration: 0, result: "bogus", explanation: "" },
        ],
      },
    ],
    [null],
  ])("is null for %j", (values) => {
    expect(lastRubricVerdict(values)).toBeNull();
  });
});
