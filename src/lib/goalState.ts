// A thread's goal as the core keeps it in state: `_goal` (objective, status,
// note, rubric_id) beside the sticky checklist `_sticky_rubric` ({text, id}).
// The goal counts only while that checklist is its own, the core's
// rubric_session.thread_goal rule: a /rubric checklist that replaced it
// leaves `_goal` behind.

export type GoalStatus = "active" | "paused" | "blocked" | "complete";
const STATUSES: ReadonlySet<string> = new Set([
  "active",
  "paused",
  "blocked",
  "complete",
]);

export interface ThreadGoal {
  objective: string;
  status: GoalStatus;
  note: string | null;
  rubricId: string;
  /** The acceptance criteria: the sticky checklist's text. */
  criteria: string;
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && STATUSES.has(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function threadGoal(values: unknown): ThreadGoal | null {
  const state = record(values);
  const goal = record(state?._goal);
  const sticky = record(state?._sticky_rubric);
  if (!goal || !sticky) return null;
  const { objective, status, note, rubric_id: rubricId } = goal;
  if (typeof rubricId !== "string" || !rubricId || rubricId !== sticky.id) {
    return null;
  }
  if (typeof objective !== "string" || !isGoalStatus(status)) return null;
  if (typeof sticky.text !== "string") return null;
  return {
    objective,
    status,
    note: typeof note === "string" ? note : null,
    rubricId,
    criteria: sticky.text,
  };
}

export type RubricResult =
  | "satisfied"
  | "needs_revision"
  | "failed"
  | "max_iterations_reached"
  | "grader_error";
const RESULTS: ReadonlySet<string> = new Set([
  "satisfied",
  "needs_revision",
  "failed",
  "max_iterations_reached",
  "grader_error",
]);

export function isRubricResult(value: unknown): value is RubricResult {
  return typeof value === "string" && RESULTS.has(value);
}

export interface RubricVerdict {
  result: RubricResult;
  explanation: string;
  iteration: number;
}

/** The thread's latest grading, from `_rubric_evaluations`. */
export function lastRubricVerdict(values: unknown): RubricVerdict | null {
  const evaluations = record(values)?._rubric_evaluations;
  if (!Array.isArray(evaluations) || evaluations.length === 0) return null;
  const last = record(evaluations[evaluations.length - 1]);
  if (!last || !isRubricResult(last.result)) return null;
  return {
    result: last.result,
    explanation: typeof last.explanation === "string" ? last.explanation : "",
    iteration: typeof last.iteration === "number" ? last.iteration : 0,
  };
}
