import type { Message } from "@langchain/langgraph-sdk";

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
  if (!record || record.length === 0)
    return state && state.length > 0 ? state : null;
  if (!state || state.length === 0) return record;
  const anchor = state[0]?.id;
  if (!anchor) return record;
  return record.some((m) => m.id === anchor) ? record : state;
}
