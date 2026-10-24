import type { Message } from "@langchain/langgraph-sdk";

// `/state` is always the root conversation, while a bare `GET /threads/{id}`
// holds the latest checkpoint of any namespace: a task sub-agent's, or the
// goal drafter's or the rubric grader's while one runs or a goal's review
// waits. The record counts only when it holds the root's first message.
export function pickThreadMessages(
  stateMessages: unknown,
  recordMessages: unknown
): Message[] | null {
  const state = Array.isArray(stateMessages)
    ? (stateMessages as Message[])
    : null;
  const record = Array.isArray(recordMessages)
    ? (recordMessages as Message[])
    : null;
  // Without the root nothing is known; an empty root anchors nothing, so a
  // record then is another namespace's and the conversation is empty.
  if (!state) return null;
  if (state.length === 0 || !record || record.length === 0) return state;
  const anchor = state[0]?.id;
  if (!anchor) return record;
  return record.some((m) => m.id === anchor) ? record : state;
}
