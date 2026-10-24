import { describe, expect, it } from "vitest";
import {
  GOAL_MENU_COMMANDS,
  GOAL_USAGE,
  goalRefusal,
  goalRequest,
  goalUsageLine,
  parseGoalCommand,
} from "./goalCommand";
import type { GoalStatus, ThreadGoal } from "./goalState";

const goal = (status: GoalStatus): ThreadGoal => ({
  objective: "Write hello",
  status,
  note: null,
  rubricId: "goal:abc",
  criteria: "- one",
});

// The core's GoalCommand (commands/implementation/goal.py).
describe("parseGoalCommand", () => {
  it.each([
    ["/goal", { kind: "show" }],
    ["/goal show", { kind: "show" }],
    ["/goal  STATUS ", { kind: "show" }],
    [
      "/goal show me the money",
      { kind: "create", objective: "show me the money" },
    ],
    ["/goal pause", { kind: "pause" }],
    ["/goal Resume", { kind: "resume" }],
    ["/goal clear", { kind: "clear" }],
    ["/goal pause now", { kind: "create", objective: "pause now" }],
    ["/goal amend tighten it", { kind: "amend", feedback: "tighten it" }],
    ["/goal AMEND  x ", { kind: "amend", feedback: "x" }],
    ["/goal amend", { kind: "usage" }],
    ["/goal amend   ", { kind: "usage" }],
    ["/goal write\nmulti", { kind: "create", objective: "write\nmulti" }],
    ["/goal\tget it done", { kind: "create", objective: "get it done" }],
  ])("%j", (text, command) => {
    expect(parseGoalCommand(text)).toEqual(command);
  });

  it.each(["/goals x", "hi /goal x", "/model x", "/goal:x", ""])(
    "%j is not a /goal command",
    (text) => {
      expect(parseGoalCommand(text)).toBeNull();
    }
  );

  // The core lowercases a command's name (commands/manager.py), so the TUI
  // takes "/Goal x" too, as a phone keyboard may type it.
  it.each([
    ["/Goal write x", { kind: "create", objective: "write x" }],
    ["/GOAL pause", { kind: "pause" }],
    ["/gOaL", { kind: "show" }],
  ])("takes %j in any case", (text, command) => {
    expect(parseGoalCommand(text)).toEqual(command);
  });
});

describe("goalRefusal", () => {
  it.each([
    [
      { kind: "amend", feedback: "x" },
      "paused",
      "The goal is paused; resume it first with /goal resume.",
    ],
    [
      { kind: "amend", feedback: "x" },
      "complete",
      "The goal is complete; set a new one with /goal <objective>.",
    ],
    [
      { kind: "pause" },
      "blocked",
      "The goal is blocked and already waits for your message.",
    ],
    [
      { kind: "pause" },
      "paused",
      "The goal is paused; only an active goal can be paused.",
    ],
    [
      { kind: "resume" },
      "active",
      "The goal is active; only a paused goal can be resumed.",
    ],
  ] as const)("%j on a %s goal", (command, status, text) => {
    expect(goalRefusal(command, goal(status))).toBe(text);
  });

  it.each([
    [{ kind: "amend", feedback: "x" }, "active"],
    [{ kind: "amend", feedback: "x" }, "blocked"],
    [{ kind: "pause" }, "active"],
    [{ kind: "resume" }, "paused"],
    [{ kind: "clear" }, "active"],
    [{ kind: "clear" }, "paused"],
    [{ kind: "clear" }, "blocked"],
    [{ kind: "clear" }, "complete"],
    [{ kind: "create", objective: "x" }, "complete"],
  ] as const)("allows %j on a %s goal", (command, status) => {
    expect(goalRefusal(command, goal(status))).toBeNull();
  });

  it.each([
    [{ kind: "amend", feedback: "x" }],
    [{ kind: "pause" }],
    [{ kind: "resume" }],
    [{ kind: "clear" }],
  ] as const)("refuses %j without a goal", (command) => {
    expect(goalRefusal(command, null)).toBe("No goal set for this thread.");
  });

  it("allows a goal to be set on a thread without one", () => {
    expect(goalRefusal({ kind: "create", objective: "x" }, null)).toBeNull();
  });

  // check_goal_text: Python's len() counts code points.
  it("refuses an objective over 8,000 characters as the core does", () => {
    expect(
      goalRefusal({ kind: "create", objective: "x".repeat(8001) }, null)
    ).toBe(
      "The goal objective is 8,001 characters; maximum is 8,000. Remove at least 1 characters."
    );
    expect(
      goalRefusal({ kind: "create", objective: "😀".repeat(8000) }, null)
    ).toBeNull();
    expect(
      goalRefusal({ kind: "create", objective: "😀".repeat(9234) }, null)
    ).toBe(
      "The goal objective is 9,234 characters; maximum is 8,000. Remove at least 1,234 characters."
    );
  });
});

describe("goalRequest", () => {
  it("makes a create request with a fresh id", () => {
    const request = goalRequest(
      { kind: "create", objective: "Write hello" },
      null
    );
    expect(request).toEqual({
      kind: "create",
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      objective: "Write hello",
    });
    expect(goalRequest({ kind: "create", objective: "x" }, null).id).not.toBe(
      request.id
    );
  });

  it("aims amend and the status changes at the goal", () => {
    expect(
      goalRequest({ kind: "amend", feedback: "tighten it" }, goal("active"))
    ).toEqual({
      kind: "amend",
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      feedback: "tighten it",
      target: "goal:abc",
    });
    expect(goalRequest({ kind: "pause" }, goal("active"))).toEqual({
      kind: "pause",
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      target: "goal:abc",
    });
  });
});

describe("GOAL_USAGE", () => {
  it("is the core's usage text", () => {
    expect(GOAL_USAGE).toEqual([
      "Usage: /goal <objective>        set a goal; you review the drafted criteria",
      "       /goal                    show the goal (also: show, status)",
      "       /goal amend <feedback>   revise the goal and its criteria",
      "       /goal pause              stop working toward it and grading against it",
      "       /goal resume             continue a paused goal",
      "       /goal clear              drop the goal and its criteria",
    ]);
  });
});

describe("goalUsageLine", () => {
  it("reads a usage line without the terminal's alignment", () => {
    expect(goalUsageLine("/goal amend <feedback>")).toEqual({
      command: "/goal amend <feedback>",
      description: "revise the goal and its criteria",
    });
    expect(goalUsageLine("/goal <objective>")).toEqual({
      command: "/goal <objective>",
      description: "set a goal; you review the drafted criteria",
    });
    expect(goalUsageLine("/goal nope")).toBeNull();
  });
});

// The `/` menu lists what the WebUI can't do with a click: /goal show is the
// goal pill (typing it still works). Each row writes what the parser reads.
describe("GOAL_MENU_COMMANDS", () => {
  it("offers the goal commands a click can't do", () => {
    expect(GOAL_MENU_COMMANDS.map((c) => c.label)).toEqual([
      "goal <objective>",
      "goal amend <feedback>",
      "goal pause",
      "goal resume",
      "goal clear",
    ]);
    expect(GOAL_MENU_COMMANDS.some((c) => c.run)).toBe(false);
    expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
  });
});
