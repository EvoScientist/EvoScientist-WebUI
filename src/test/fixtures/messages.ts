import type { Message } from "@langchain/langgraph-sdk";

export const humanTurn = (content = "hi", id = "u1"): Message =>
  ({ id, type: "human", content } as Message);

export const aiTurn = (content = "hello", id = "a1"): Message =>
  ({ id, type: "ai", content } as Message);

export const aiToolCallTurn = (
  toolName: string,
  args: Record<string, unknown>,
  id = "t1"
): Message =>
  ({
    id,
    type: "ai",
    content: "",
    tool_calls: [{ id: `${id}c`, name: toolName, args }],
  } as unknown as Message);

export const toolResultTurn = (
  content = "ok",
  id = "t1r",
  tool_call_id = "t1c"
): Message =>
  ({ id, type: "tool", content, tool_call_id } as unknown as Message);
