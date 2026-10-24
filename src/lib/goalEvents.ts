import {
  isGoalStatus,
  isRubricResult,
  type GoalStatus,
  type RubricResult,
} from "@/lib/goalState";
import { pySplit, pyStrip } from "@/lib/pythonWhitespace";

// The core's goal and grading events ride the custom channel as untagged
// dicts: middleware/goal.py emit_goal_event, deepagents RubricMiddleware's
// rubric_evaluation_start / _end, and EvoRubricMiddleware's
// rubric_evaluation_deferred. The notices copy the CLI's lines
// (stream/display.py goal_event_lines, _RUBRIC_RESULT_LINES,
// rubric_deferred_text) word for word; the CLI's colour picks the toast
// level, and its dim lines show only in the goal pill.

export type GoalChange =
  | "drafting"
  | "accepted"
  | "amended"
  | "cancelled"
  | "failed"
  | "ignored"
  | "paused"
  | "resumed"
  | "cleared"
  | "blocked"
  | "unblocked"
  | "complete"
  | "unmet";

export type GoalEvent =
  | {
      type: "goal_state";
      change: GoalChange;
      status?: GoalStatus;
      note?: string;
      criteria?: string;
      unreviewed?: boolean;
    }
  | { type: "rubric_evaluation_start"; gradingRunId: string; iteration: number }
  | {
      type: "rubric_evaluation_end";
      gradingRunId: string;
      iteration: number;
      result: RubricResult;
      explanation: string;
    }
  | { type: "rubric_evaluation_deferred"; tasks: number; processes: number };

type Level = "info" | "success" | "warning" | "error";
export interface GoalNotice {
  level: Level;
  text: string;
}

// [CLI line, toast level]; null where the CLI line is dim.
const GOAL_LINES: Record<GoalChange, [string, Level | null]> = {
  drafting: ["Drafting acceptance criteria...", null],
  accepted: ["Goal accepted.", "success"],
  amended: ["Goal amended.", "success"],
  cancelled: ["Goal proposal cancelled.", "warning"],
  failed: ["Goal request failed", "error"],
  paused: ["Goal paused.", "warning"],
  resumed: ["Goal resumed.", "success"],
  cleared: ["Goal cleared.", "warning"],
  ignored: ["Nothing was changed", "warning"],
  blocked: ["Goal blocked", "warning"],
  unblocked: ["Goal unblocked.", null],
  // Dim in the CLI, under the verdict lines; here a toast is the only place
  // that says the goal was not met.
  unmet: [
    "The goal stays active: send a message to continue, /goal amend to change it, /goal clear to drop it.",
    "info",
  ],
  complete: ["Goal complete.", "success"],
};
const UNREVIEWED: Partial<Record<GoalChange, string>> = {
  accepted: "Goal accepted without review (auto mode).",
  amended: "Goal amended without review (auto mode).",
};
const NOTE_AFTER_COLON: ReadonlySet<GoalChange> = new Set([
  "failed",
  "ignored",
  "blocked",
]);
// A note can be 4,000 characters; a line shows its start.
const NOTE_SHOWN = 240;

/** The CLI's line for each grading result (_RUBRIC_RESULT_LINES). */
export const RUBRIC_RESULT_TEXT: Record<RubricResult, string> = {
  satisfied: "Acceptance criteria satisfied",
  needs_revision: "Acceptance criteria not yet satisfied",
  max_iterations_reached:
    "Acceptance criteria not satisfied (pass limit reached)",
  failed: "Rubric cannot be evaluated",
  grader_error: "Acceptance criteria check failed",
};
// satisfied has no toast: the goal's own "Goal complete." says it.
const RESULT_LEVELS: Record<RubricResult, Level | null> = {
  satisfied: null,
  needs_revision: "warning",
  max_iterations_reached: "warning",
  failed: "error",
  grader_error: "error",
};

const CHANGES: ReadonlySet<string> = new Set(Object.keys(GOAL_LINES));

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseGoalEvent(data: unknown): GoalEvent | null {
  const d = record(data);
  if (!d) return null;
  if (d.type === "goal_state") {
    if (typeof d.change !== "string" || !CHANGES.has(d.change)) return null;
    const event: Extract<GoalEvent, { type: "goal_state" }> = {
      type: "goal_state",
      change: d.change as GoalChange,
    };
    if (isGoalStatus(d.status)) event.status = d.status;
    if (typeof d.note === "string") event.note = d.note;
    if (typeof d.criteria === "string") event.criteria = d.criteria;
    if (d.unreviewed === true) event.unreviewed = true;
    return event;
  }
  if (
    d.type === "rubric_evaluation_start" ||
    d.type === "rubric_evaluation_end"
  ) {
    if (
      typeof d.grading_run_id !== "string" ||
      typeof d.iteration !== "number"
    ) {
      return null;
    }
    if (d.type === "rubric_evaluation_start") {
      return {
        type: "rubric_evaluation_start",
        gradingRunId: d.grading_run_id,
        iteration: d.iteration,
      };
    }
    if (!isRubricResult(d.result)) return null;
    return {
      type: "rubric_evaluation_end",
      gradingRunId: d.grading_run_id,
      iteration: d.iteration,
      result: d.result,
      explanation: typeof d.explanation === "string" ? d.explanation : "",
    };
  }
  if (d.type === "rubric_evaluation_deferred") {
    if (typeof d.tasks !== "number" || typeof d.processes !== "number") {
      return null;
    }
    return {
      type: "rubric_evaluation_deferred",
      tasks: d.tasks,
      processes: d.processes,
    };
  }
  return null;
}

// goal_event_lines: whitespace collapsed, a long note cut at its start.
function shownNote(note: string): string {
  const collapsed = pySplit(note).join(" ");
  const chars = Array.from(collapsed);
  if (chars.length <= NOTE_SHOWN) return collapsed;
  return pyStrip(chars.slice(0, NOTE_SHOWN - 3).join("")) + "...";
}

// rubric_deferred_text.
function deferredText(tasks: number, processes: number): string {
  const parts: string[] = [];
  if (tasks) parts.push(`${tasks} background task${tasks !== 1 ? "s" : ""}`);
  if (processes) {
    const noun = tasks ? "process" : "background process";
    parts.push(`${processes} ${noun}${processes !== 1 ? "es" : ""}`);
  }
  const what = parts.length ? parts.join(" and ") : "background work";
  return `Acceptance check deferred: ${what} still running`;
}

export function goalEventNotice(event: GoalEvent): GoalNotice | null {
  if (event.type === "goal_state") {
    const unreviewed = event.unreviewed ? UNREVIEWED[event.change] : undefined;
    if (unreviewed) return { level: "warning", text: unreviewed };
    const [line, level] = GOAL_LINES[event.change];
    if (!level) return null;
    const note = event.note ? shownNote(event.note) : "";
    let text = line;
    if (note && NOTE_AFTER_COLON.has(event.change)) text = `${line}: ${note}`;
    else if (
      note &&
      (event.change === "complete" || event.change === "cleared")
    ) {
      text = `${line} ${note}`;
    } else if (NOTE_AFTER_COLON.has(event.change)) text = `${line}.`;
    return { level, text };
  }
  if (event.type === "rubric_evaluation_end") {
    const level = RESULT_LEVELS[event.result];
    if (!level) return null;
    // rubric_result_lines: the explanation after the result, shortened here
    // like a note.
    const label = RUBRIC_RESULT_TEXT[event.result];
    const explanation = shownNote(event.explanation);
    return { level, text: explanation ? `${label}: ${explanation}` : label };
  }
  if (event.type === "rubric_evaluation_deferred") {
    // Yellow in the CLI, like its other warnings.
    return {
      level: "warning",
      text: deferredText(event.tasks, event.processes),
    };
  }
  return null;
}

/** One event's identity, to show a replayed event once per run. */
export function goalEventKey(event: GoalEvent): string {
  return JSON.stringify(event);
}
