import { describe, expect, it } from "vitest";
import {
  messagesToSubAgentSteps,
  subAgentStreamsToSteps,
} from "./subAgentActivity";

describe("messagesToSubAgentSteps", () => {
  it("emits ai text before its tool calls", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "thinking...",
        tool_calls: [{ id: "tc1", name: "execute", args: { cmd: "ls" } }],
      },
    ]);
    expect(steps).toEqual([
      { kind: "text", text: "thinking..." },
      {
        kind: "tool_call",
        id: "tc1",
        name: "execute",
        args: { cmd: "ls" },
      },
    ]);
  });

  it("normalizes OpenAI-style additional_kwargs.tool_calls (string args)", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        additional_kwargs: {
          tool_calls: [
            {
              id: "tc1",
              function: {
                name: "execute",
                arguments: '{"command":"ls"}',
              },
            },
          ],
        },
      },
    ]);
    expect(steps).toEqual([
      {
        kind: "tool_call",
        id: "tc1",
        name: "execute",
        args: { command: "ls" },
      },
    ]);
  });

  it("normalizes additional_kwargs with object arguments", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        additional_kwargs: {
          tool_calls: [
            { id: "tc1", function: { name: "n", arguments: { x: 1 } } },
          ],
        },
      },
    ]);
    expect(steps).toEqual([
      { kind: "tool_call", id: "tc1", name: "n", args: { x: 1 } },
    ]);
  });

  it("falls back to {input: raw} for non-JSON string arguments", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        additional_kwargs: {
          tool_calls: [
            { id: "tc1", function: { name: "n", arguments: "not-json" } },
          ],
        },
      },
    ]);
    expect(steps).toEqual([
      { kind: "tool_call", id: "tc1", name: "n", args: { input: "not-json" } },
    ]);
  });

  it("prefers top-level tool_calls over additional_kwargs", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        tool_calls: [{ id: "primary", name: "p", args: {} }],
        additional_kwargs: {
          tool_calls: [
            { id: "secondary", function: { name: "s", arguments: "{}" } },
          ],
        },
      },
    ]);
    expect(steps.map((s) => (s as { id?: string }).id)).toEqual(["primary"]);
  });

  it("emits tool results and skips human messages", () => {
    const steps = messagesToSubAgentSteps([
      { type: "human", content: "the prompt" },
      {
        type: "tool",
        name: "execute",
        tool_call_id: "tc1",
        content: "output",
      },
    ]);
    expect(steps).toEqual([
      {
        kind: "tool_result",
        toolCallId: "tc1",
        name: "execute",
        text: "output",
      },
    ]);
  });
});

describe("subAgentStreamsToSteps", () => {
  it("preserves the SDK's exact task tool-call ids", () => {
    const streams = new Map([
      [
        "task-call-b",
        {
          messages: [
            { type: "human", content: "same prompt" },
            { type: "ai", content: "same result" },
          ],
        },
      ],
      [
        "task-call-a",
        {
          messages: [
            { type: "human", content: "same prompt" },
            { type: "ai", content: "same result" },
          ],
        },
      ],
    ]);

    expect(subAgentStreamsToSteps(streams)).toEqual({
      "task-call-b": [{ kind: "text", text: "same result" }],
      "task-call-a": [{ kind: "text", text: "same result" }],
    });
  });

  it("omits streams without renderable steps", () => {
    expect(
      subAgentStreamsToSteps(
        new Map([
          ["empty", { messages: [{ type: "human", content: "prompt" }] }],
        ])
      )
    ).toEqual({});
  });
});
