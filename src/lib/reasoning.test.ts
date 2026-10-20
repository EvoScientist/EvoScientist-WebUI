import { describe, expect, it } from "vitest";
import { messageReasoning } from "./reasoning";

describe("messageReasoning", () => {
  it("reads reasoning_content first, as the CLI does", () => {
    expect(
      messageReasoning({
        additional_kwargs: { reasoning_content: "  Check the logs.  " },
        content: [{ type: "thinking", thinking: "Something else." }],
      })
    ).toEqual({ text: "Check the logs.", markdown: false });
  });

  it("reads Claude's thinking blocks as plain text", () => {
    expect(
      messageReasoning({
        content: [
          { type: "thinking", thinking: "First." },
          { type: "text", text: "The answer." },
          { type: "thinking", thinking: "Second." },
        ],
      })
    ).toEqual({ text: "First.\n\nSecond.", markdown: false });
  });

  it("reads an OpenAI reasoning summary as Markdown, its parts in order", () => {
    expect(
      messageReasoning({
        content: [
          {
            type: "reasoning",
            summary: [
              { type: "summary_text", text: "**Plan** one." },
              { type: "summary_text", text: "Then two." },
            ],
          },
        ],
      })
    ).toEqual({ text: "**Plan** one.\n\nThen two.", markdown: true });
  });

  it("reads a standard reasoning block as plain text", () => {
    expect(
      messageReasoning({ content: [{ type: "reasoning", reasoning: "Hmm." }] })
    ).toEqual({ text: "Hmm.", markdown: false });
  });

  it("shows a summary mixed with plain reasoning as plain text", () => {
    expect(
      messageReasoning({
        content: [
          { type: "thinking", thinking: "Plain." },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Summary." }],
          },
        ],
      })
    ).toEqual({ text: "Plain.\n\nSummary.", markdown: false });
  });

  it.each([
    ["text content", { content: "Just an answer." }],
    [
      "blank reasoning_content",
      { additional_kwargs: { reasoning_content: " " } },
    ],
    [
      "redacted thinking",
      { content: [{ type: "redacted_thinking", data: "x" }] },
    ],
    [
      "a summary-less reasoning block",
      { content: [{ type: "reasoning", summary: [] }] },
    ],
    ["null entries", { content: [null, { type: "thinking", thinking: "  " }] }],
  ])("finds no reasoning in %s", (_label, message) => {
    expect(messageReasoning(message)).toBeNull();
  });
});
