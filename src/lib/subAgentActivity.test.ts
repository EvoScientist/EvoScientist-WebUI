import { describe, expect, it } from "vitest";
import {
  messagesToSubAgentSteps,
  subAgentStreamsToSteps,
  taskSubAgentName,
} from "./subAgentActivity";

describe("taskSubAgentName", () => {
  it.each([
    [{ subagent_type: "code-agent" }, "code-agent"],
    [{ subagent_type: "  " }, null],
    [{ subagent_type: "" }, null],
    [{ subagent_type: {} }, null],
    [{ subagent_type: ["code-agent"] }, null],
    [{}, null],
  ])("reads %j as %j", (args, name) => {
    expect(taskSubAgentName(args)).toBe(name);
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

  // A malformed message can hold null or other non-object entries; reading
  // one threw.
  const steps2 = [
    { kind: "tool_call", id: "tc1", name: "execute", args: { cmd: "ls" } },
    { kind: "tool_call", id: "tc2", name: "read", args: { path: "/" } },
  ];
  it.each([
    [
      "tool_calls",
      {
        tool_calls: [
          { id: "tc1", name: "execute", args: { cmd: "ls" } },
          null,
          "oops",
          { id: "tc2", name: "read", args: { path: "/" } },
        ],
      },
    ],
    [
      "additional_kwargs.tool_calls",
      {
        additional_kwargs: {
          tool_calls: [
            {
              id: "tc1",
              function: { name: "execute", arguments: '{"cmd":"ls"}' },
            },
            null,
            "oops",
            {
              id: "tc2",
              function: { name: "read", arguments: '{"path":"/"}' },
            },
          ],
        },
      },
    ],
  ])("skips bad entries in %s", (_label, fields) => {
    const steps = messagesToSubAgentSteps([
      { type: "ai", content: "", ...fields },
    ]);

    expect(steps).toEqual(steps2);
  });

  // tool_calls first, unless it holds no call: empty, or only bad entries.
  const kwargs2 = [
    { id: "tc1", function: { name: "execute", arguments: '{"cmd":"ls"}' } },
    { id: "tc2", function: { name: "read", arguments: '{"path":"/"}' } },
  ];
  it.each([
    ["holds only bad entries", [null, "oops"], kwargs2, steps2],
    ["is empty", [], kwargs2, steps2],
    ["and additional_kwargs both hold only bad entries", [null], [null, 7], []],
  ])(
    "reads additional_kwargs when tool_calls %s",
    (_label, toolCalls, kwargs, expected) => {
      const steps = messagesToSubAgentSteps([
        {
          type: "ai",
          content: "",
          tool_calls: toolCalls,
          additional_kwargs: { tool_calls: kwargs },
        },
      ]);

      expect(steps).toEqual(expected);
    }
  );

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

describe("messagesToSubAgentSteps reasoning", () => {
  it("puts a message's reasoning before its text and tool calls", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: [
          { type: "thinking", thinking: "Look first." },
          { type: "text", text: "Listing files." },
        ],
        tool_calls: [{ id: "c1", name: "ls", args: {} }],
      },
    ]);
    expect(steps).toEqual([
      { kind: "reasoning", text: "Look first.", markdown: false },
      { kind: "text", text: "Listing files." },
      { kind: "tool_call", id: "c1", name: "ls", args: {} },
    ]);
  });

  it("reads reasoning the way the chat does", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        additional_kwargs: { reasoning_content: "Plain plan." },
      },
      {
        type: "ai",
        content: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "**Summary**" }],
          },
        ],
      },
    ]);
    expect(steps).toEqual([
      { kind: "reasoning", text: "Plain plan.", markdown: false },
      { kind: "reasoning", text: "**Summary**", markdown: true },
    ]);
  });

  // While the sub-agent thinks, its reasoning is all there is to show.
  it("keeps a task whose sub-agent has only reasoned so far", () => {
    const out = subAgentStreamsToSteps(
      new Map([
        [
          "task-1",
          {
            messages: [
              { type: "ai", content: [{ type: "thinking", thinking: "Hm." }] },
            ],
          },
        ],
      ])
    );
    expect(out).toEqual({
      "task-1": [{ kind: "reasoning", text: "Hm.", markdown: false }],
    });
  });
});

describe("messagesToSubAgentSteps tool-call dedupe", () => {
  it("collapses a repeated tool_call id within one ai message", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        tool_calls: [
          { id: "c1", name: "execute", args: { command: "ls" } },
          { id: "c1", name: "execute", args: { command: "ls" } },
        ],
      },
    ]);
    expect(steps).toEqual([
      { kind: "tool_call", id: "c1", name: "execute", args: { command: "ls" } },
    ]);
  });

  it("keeps the duplicate's args when the kept copy has none", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        tool_calls: [
          { id: "c1", name: "execute", args: {} },
          { id: "c1", name: "execute", args: { command: "ls" } },
        ],
      },
    ]);
    expect(steps).toEqual([
      { kind: "tool_call", id: "c1", name: "execute", args: { command: "ls" } },
    ]);
  });

  it("keeps id-less calls apart", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "ai",
        content: "",
        tool_calls: [
          { name: "execute", args: { command: "ls" } },
          { name: "execute", args: { command: "pwd" } },
        ],
      },
    ]);
    expect(steps).toHaveLength(2);
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

  it("skips null and non-object messages without throwing", () => {
    expect(
      subAgentStreamsToSteps(
        new Map([
          [
            "task-1",
            {
              messages: [
                null,
                undefined,
                "stray string",
                42,
                { type: "ai", content: "still works" },
              ],
            },
          ],
        ])
      )
    ).toEqual({ "task-1": [{ kind: "text", text: "still works" }] });
  });

  it("marks a tool result that failed", () => {
    const steps = messagesToSubAgentSteps([
      {
        type: "tool",
        name: "edit_file",
        tool_call_id: "tc1",
        content: "Error: String not found",
        status: "error",
      },
      {
        type: "tool",
        name: "ls",
        tool_call_id: "tc2",
        content: "a.txt",
        status: "success",
      },
    ]);
    expect(steps).toEqual([
      {
        kind: "tool_result",
        toolCallId: "tc1",
        name: "edit_file",
        text: "Error: String not found",
        failed: true,
      },
      { kind: "tool_result", toolCallId: "tc2", name: "ls", text: "a.txt" },
    ]);
  });
});
