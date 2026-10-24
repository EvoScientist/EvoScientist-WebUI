import { v4 as uuidv4 } from "uuid";
import type { GoalStatus, ThreadGoal } from "@/lib/goalState";
import { PY_SPACE, pySplit, pyStrip } from "@/lib/pythonWhitespace";
import type { MenuCommand } from "@/lib/slashMenu";

// The /goal command, read and checked the way the core's GoalCommand
// (commands/implementation/goal.py) does, so the WebUI and the TUI take the
// same text the same way and refuse a request with the same words.

export type GoalCommand =
  | { kind: "show" }
  | { kind: "usage" }
  | { kind: "create"; objective: string }
  | { kind: "amend"; feedback: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

export type GoalRequestCommand = Extract<
  GoalCommand,
  { kind: "create" | "amend" | "pause" | "resume" | "clear" }
>;

/** A run input's `goal_request` (the core's new_goal_request). */
export interface GoalRequest {
  kind: GoalRequestCommand["kind"];
  id: string;
  objective?: string;
  feedback?: string;
  target?: string;
}

/** The core's _USAGE, word for word. */
export const GOAL_USAGE: readonly string[] = [
  "Usage: /goal <objective>        set a goal; you review the drafted criteria",
  "       /goal                    show the goal (also: show, status)",
  "       /goal amend <feedback>   revise the goal and its criteria",
  "       /goal pause              stop working toward it and grading against it",
  "       /goal resume             continue a paused goal",
  "       /goal clear              drop the goal and its criteria",
];

/** The `/` menu's /goal rows: the core's GoalCommand and the subcommands a
 *  click can't do, their descriptions word for word. Show is the goal pill
 *  (typing `/goal show` still works). */
export const GOAL_MENU_COMMANDS: readonly MenuCommand[] = [
  {
    word: "goal",
    label: "goal <objective>",
    insert: "/goal ",
    description: "Set a goal with drafted acceptance criteria",
  },
  {
    word: "goal",
    label: "goal amend <feedback>",
    insert: "/goal amend ",
    description: "Revise the goal and its criteria",
  },
  {
    word: "goal",
    label: "goal pause",
    insert: "/goal pause",
    description: "Stop working toward the goal",
  },
  {
    word: "goal",
    label: "goal resume",
    insert: "/goal resume",
    description: "Continue a paused goal",
  },
  {
    word: "goal",
    label: "goal clear",
    insert: "/goal clear",
    description: "Drop the goal and its criteria",
  },
];

/** The core's _NO_GOAL. */
export const NO_GOAL_TEXT = "No goal set for this thread.";
// GOAL_OBJECTIVE_LIMIT, in Python's len(): code points.
const OBJECTIVE_LIMIT = 8_000;
// GOAL_REQUEST_STATUSES.
const ALLOWED: Record<
  "amend" | "pause" | "resume" | "clear",
  readonly GoalStatus[]
> = {
  amend: ["active", "blocked"],
  pause: ["active"],
  resume: ["paused"],
  clear: ["active", "paused", "blocked", "complete"],
};
const SHOW_WORDS: ReadonlySet<string> = new Set(["", "show", "status"]);
const STATUS_WORDS: ReadonlySet<string> = new Set(["pause", "resume", "clear"]);

export function parseGoalCommand(text: string): GoalCommand | null {
  const typed = pyStrip(text);
  // The core lowercases a command's name (commands/manager.py).
  if (typed.slice(0, "/goal".length).toLowerCase() !== "/goal") return null;
  const rest = typed.slice("/goal".length);
  if (rest && !PY_SPACE.test(rest[0])) return null;
  // A subcommand is the whole remainder, so "/goal show me the money" sets a
  // goal; only amend takes text after it.
  const raw = pyStrip(rest);
  const word = raw.toLowerCase();
  if (SHOW_WORDS.has(word)) return { kind: "show" };
  if (STATUS_WORDS.has(word)) {
    return { kind: word as "pause" | "resume" | "clear" };
  }
  const [head = "", tail = ""] = pySplit(raw, 1);
  if (head.toLowerCase() === "amend") {
    const feedback = pyStrip(tail);
    return feedback ? { kind: "amend", feedback } : { kind: "usage" };
  }
  return { kind: "create", objective: raw };
}

/** One line of GOAL_USAGE without the terminal's alignment: the command
 *  ("/goal amend <feedback>") and what it does. */
export function goalUsageLine(
  command: string
): { command: string; description: string } | null {
  for (const line of GOAL_USAGE) {
    const [usage, description = ""] = line
      .replace(/^Usage:/, "")
      .trim()
      .split(/\s{2,}/);
    if (usage === command) return { command: usage, description };
  }
  return null;
}

const grouped = (n: number) => n.toLocaleString("en-US");

// _refusal.
function refusal(
  kind: "amend" | "pause" | "resume",
  status: GoalStatus
): string {
  if (kind === "amend" && status === "paused") {
    return "The goal is paused; resume it first with /goal resume.";
  }
  if (kind === "amend") {
    return `The goal is ${status}; set a new one with /goal <objective>.`;
  }
  if (kind === "pause" && status === "blocked") {
    return "The goal is blocked and already waits for your message.";
  }
  const wanted = kind === "pause" ? "an active" : "a paused";
  return `The goal is ${status}; only ${wanted} goal can be ${kind}d.`;
}

/** Why the core would refuse this command on this goal, or null. */
export function goalRefusal(
  command: GoalCommand,
  goal: ThreadGoal | null
): string | null {
  if (command.kind === "show" || command.kind === "usage") return null;
  if (command.kind === "create") {
    // check_goal_text.
    const size = Array.from(command.objective).length;
    if (size <= OBJECTIVE_LIMIT) return null;
    return (
      `The goal objective is ${grouped(size)} characters; maximum is ` +
      `${grouped(OBJECTIVE_LIMIT)}. Remove at least ` +
      `${grouped(size - OBJECTIVE_LIMIT)} characters.`
    );
  }
  if (!goal) return NO_GOAL_TEXT;
  if (ALLOWED[command.kind].includes(goal.status)) return null;
  if (command.kind === "clear") return null;
  return refusal(command.kind, goal.status);
}

export function goalRequest(
  command: GoalRequestCommand,
  goal: ThreadGoal | null
): GoalRequest {
  const id = uuidv4().replace(/-/g, "");
  if (command.kind === "create") {
    return { kind: "create", id, objective: command.objective };
  }
  const target = goal ? { target: goal.rubricId } : {};
  if (command.kind === "amend") {
    return { kind: "amend", id, feedback: command.feedback, ...target };
  }
  return { kind: command.kind, id, ...target };
}
