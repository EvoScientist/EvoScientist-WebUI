import type { Message } from "@langchain/langgraph-sdk";

// The rubric grader's feedback when a grading asks for revisions: a HUMAN
// message the backend adds, tagged like a pinned skill (deepagents
// RubricMiddleware: name and additional_kwargs.lc_source "rubric_grader").
// It is the grader's, not the user's: the chat shows it as a collapsed row
// (the CLI's message_meta label), and it is no user turn.

/** The CLI's RUBRIC_FEEDBACK_LABEL. */
export const RUBRIC_REVISION_LABEL = "rubric: revision requested";

export function isRubricRevision(message: Message): boolean {
  if (message.type !== "human") return false;
  const ak = (message as { additional_kwargs?: Record<string, unknown> })
    .additional_kwargs;
  return ak?.["lc_source"] === "rubric_grader";
}
