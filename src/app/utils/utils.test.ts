import { describe, expect, it } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import { getMessageToolCalls } from "./utils";

// A malformed message can hold null or other non-object entries; a null in
// additional_kwargs.tool_calls, which the backend stores as given, blanked
// the whole chat.
describe("getMessageToolCalls", () => {
  const ai = (fields: Record<string, unknown>) =>
    ({ id: "a1", type: "ai", content: "", ...fields } as unknown as Message);
  const ls = { id: "c1", name: "ls", args: { path: "/" } };
  const grep = { id: "c2", name: "grep", args: { pattern: "x" } };

  it("skips bad content blocks", () => {
    const message = ai({
      content: [
        { type: "tool_use", id: "c1", name: "ls", input: { path: "/" } },
        null,
        "text",
        { type: "tool_use", id: "c2", name: "grep", input: { pattern: "x" } },
      ],
    });

    expect(getMessageToolCalls(message)).toEqual([ls, grep]);
  });

  it("skips bad tool calls", () => {
    const message = ai({ tool_calls: [ls, null, 7, grep] });

    expect(getMessageToolCalls(message)).toEqual([ls, grep]);
  });

  it("skips bad OpenAI tool calls", () => {
    const message = ai({
      additional_kwargs: {
        tool_calls: [
          { id: "c1", function: { name: "ls", arguments: '{"path":"/"}' } },
          null,
          "oops",
          {
            id: "c2",
            function: { name: "grep", arguments: '{"pattern":"x"}' },
          },
        ],
      },
    });

    expect(getMessageToolCalls(message)).toEqual([ls, grep]);
  });

  it("reads the next list when one holds only bad entries", () => {
    const message = ai({
      additional_kwargs: { tool_calls: [null, "oops", 7] },
      tool_calls: [ls],
    });

    expect(getMessageToolCalls(message)).toEqual([ls]);
  });

  it("reads the content when the tool calls hold only bad entries", () => {
    const message = ai({
      tool_calls: [null, "oops", 7],
      content: [
        { type: "tool_use", id: "c1", name: "ls", input: { path: "/" } },
      ],
    });

    expect(getMessageToolCalls(message)).toEqual([ls]);
  });

  it.each([
    [
      "additional_kwargs",
      { additional_kwargs: { tool_calls: [] }, tool_calls: [ls] },
    ],
    [
      "tool_calls",
      {
        tool_calls: [],
        content: [
          { type: "tool_use", id: "c1", name: "ls", input: { path: "/" } },
        ],
      },
    ],
  ])("still takes an empty %s list as no tool calls", (_label, fields) => {
    expect(getMessageToolCalls(ai(fields))).toEqual([]);
  });
});
