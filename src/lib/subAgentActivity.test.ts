import { describe, expect, it } from "vitest";
import {
  extractSubAgentSteps,
  lastTextOf,
  messagesToSubAgentSteps,
  type SubAgentStep,
} from "./subAgentActivity";

describe("extractSubAgentSteps", () => {
  it("returns [] for non-object input", () => {
    expect(extractSubAgentSteps(null)).toEqual([]);
    expect(extractSubAgentSteps(undefined)).toEqual([]);
    expect(extractSubAgentSteps("string")).toEqual([]);
  });

  it("skips nodes whose messages field is not an array", () => {
    expect(extractSubAgentSteps({ node: { messages: "not-array" } })).toEqual(
      []
    );
    expect(extractSubAgentSteps({ node: {} })).toEqual([]);
  });

  it("extracts tool_calls from an ai message", () => {
    const steps = extractSubAgentSteps({
      agent: {
        messages: [
          {
            type: "ai",
            tool_calls: [
              { id: "tc1", name: "execute", args: { command: "ls" } },
              { id: "tc2", name: "read_file", args: { path: "/a" } },
            ],
          },
        ],
      },
    });
    expect(steps).toEqual([
      {
        kind: "tool_call",
        id: "tc1",
        name: "execute",
        args: { command: "ls" },
      },
      {
        kind: "tool_call",
        id: "tc2",
        name: "read_file",
        args: { path: "/a" },
      },
    ]);
  });

  it("emits ai text (trimmed) when there are no tool_calls", () => {
    const steps = extractSubAgentSteps({
      agent: {
        messages: [{ type: "ai", content: "  hello world  " }],
      },
    });
    expect(steps).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("skips empty ai text", () => {
    const steps = extractSubAgentSteps({
      agent: { messages: [{ type: "ai", content: "   " }] },
    });
    expect(steps).toEqual([]);
  });

  it("flattens content-block arrays into a single string", () => {
    const steps = extractSubAgentSteps({
      agent: {
        messages: [
          {
            type: "ai",
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        ],
      },
    });
    expect(steps).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("extracts tool results", () => {
    const steps = extractSubAgentSteps({
      tools: {
        messages: [
          {
            type: "tool",
            name: "execute",
            tool_call_id: "tc1",
            content: "ok",
          },
        ],
      },
    });
    expect(steps).toEqual([
      { kind: "tool_result", toolCallId: "tc1", name: "execute", text: "ok" },
    ]);
  });

  it("defaults tool name/id when missing", () => {
    const steps = extractSubAgentSteps({
      tools: {
        messages: [{ type: "tool", content: "x" }],
      },
    });
    expect(steps).toEqual([
      { kind: "tool_result", toolCallId: "", name: "tool", text: "x" },
    ]);
  });

  it("defaults tool_call args to {} when not an object", () => {
    const steps = extractSubAgentSteps({
      agent: {
        messages: [
          {
            type: "ai",
            tool_calls: [{ id: "tc", name: "n", args: "not-an-object" }],
          },
        ],
      },
    });
    expect(steps).toEqual([
      { kind: "tool_call", id: "tc", name: "n", args: {} },
    ]);
  });
});

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

describe("lastTextOf", () => {
  it("returns the last text step's text", () => {
    const steps: SubAgentStep[] = [
      { kind: "text", text: "first" },
      { kind: "tool_call", id: "tc", name: "n", args: {} },
      { kind: "text", text: "last" },
    ];
    expect(lastTextOf(steps)).toBe("last");
  });

  it("returns '' when there is no text step", () => {
    const steps: SubAgentStep[] = [
      { kind: "tool_call", id: "tc", name: "n", args: {} },
    ];
    expect(lastTextOf(steps)).toBe("");
  });

  it("returns '' for an empty list", () => {
    expect(lastTextOf([])).toBe("");
  });
});
