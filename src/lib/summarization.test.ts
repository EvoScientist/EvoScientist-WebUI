import { describe, expect, it } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import {
  extractSummaryBody,
  isSummarizationContent,
  isSummarizationMessage,
  parseSummarizationEvent,
} from "./summarization";

describe("isSummarizationContent", () => {
  it("matches the offloaded wrapper", () => {
    expect(
      isSummarizationContent(
        "You are in the middle of a conversation that has been summarized."
      )
    ).toBe(true);
  });

  it("matches the non-offloaded lead-in", () => {
    expect(
      isSummarizationContent(
        "Here is a summary of the conversation to date:\n\n## SESSION INTENT"
      )
    ).toBe(true);
  });

  it("matches a <summary>...</summary> region", () => {
    expect(isSummarizationContent("<summary>anything</summary>")).toBe(true);
  });

  it("matches on the ## SESSION INTENT lead header alone", () => {
    expect(isSummarizationContent("## SESSION INTENT\nfoo")).toBe(true);
  });

  it("returns false for regular text and empty input", () => {
    expect(isSummarizationContent("hello world")).toBe(false);
    expect(isSummarizationContent("")).toBe(false);
    expect(isSummarizationContent(undefined)).toBe(false);
    expect(isSummarizationContent(null)).toBe(false);
  });
});

describe("isSummarizationMessage", () => {
  it("matches human messages ONLY by the lc_source marker", () => {
    const marked = {
      type: "human",
      content: "## SESSION INTENT\nfoo",
      additional_kwargs: { lc_source: "summarization" },
    } as unknown as Message;
    const noMarker = {
      type: "human",
      content: "## SESSION INTENT\nfoo",
    } as unknown as Message;
    expect(isSummarizationMessage(marked)).toBe(true);
    // Even though the content pattern matches, no marker => not a summary.
    expect(isSummarizationMessage(noMarker)).toBe(false);
  });

  it("matches ai messages by content pattern", () => {
    const aiSummary = {
      type: "ai",
      content: "## SESSION INTENT\nfoo",
    } as unknown as Message;
    const aiOther = {
      type: "ai",
      content: "just an answer",
    } as unknown as Message;
    expect(isSummarizationMessage(aiSummary)).toBe(true);
    expect(isSummarizationMessage(aiOther)).toBe(false);
  });

  it("returns false for other message types", () => {
    expect(
      isSummarizationMessage({
        type: "tool",
        content: "## SESSION INTENT",
      } as unknown as Message)
    ).toBe(false);
  });
});

describe("extractSummaryBody", () => {
  it("returns the inside of a <summary> region trimmed", () => {
    expect(
      extractSummaryBody("wrap\n<summary>\n\nthe body\n\n</summary>\nafter")
    ).toBe("the body");
  });

  it("extracts body after 'Here is a summary of the conversation to date:'", () => {
    expect(
      extractSummaryBody(
        "Here is a summary of the conversation to date:\n\n## SESSION INTENT\nfoo"
      )
    ).toBe("## SESSION INTENT\nfoo");
  });

  it("falls back to trimmed input when no wrapper is present", () => {
    expect(extractSummaryBody("  hello  ")).toBe("hello");
  });

  it("returns '' for empty input", () => {
    expect(extractSummaryBody("")).toBe("");
  });
});

describe("parseSummarizationEvent", () => {
  it("returns null for non-object input", () => {
    expect(parseSummarizationEvent(null)).toBeNull();
    expect(parseSummarizationEvent(undefined)).toBeNull();
    expect(parseSummarizationEvent("string")).toBeNull();
  });

  it("returns null when summary_message content is missing or non-string", () => {
    expect(parseSummarizationEvent({ cutoff_index: 2 })).toBeNull();
    expect(
      parseSummarizationEvent({ summary_message: { content: 42 } })
    ).toBeNull();
    expect(
      parseSummarizationEvent({ summary_message: { content: "" } })
    ).toBeNull();
  });

  it("normalizes cutoff_index (missing/invalid -> 0)", () => {
    const ev = parseSummarizationEvent({
      summary_message: { content: "body" },
    });
    expect(ev).toEqual({ cutoffIndex: 0, content: "body", filePath: null });
  });

  it("clamps a negative cutoff_index to 0", () => {
    const ev = parseSummarizationEvent({
      summary_message: { content: "body" },
      cutoff_index: -3,
    });
    expect(ev?.cutoffIndex).toBe(0);
  });

  it("passes through file_path when it is a string", () => {
    const ev = parseSummarizationEvent({
      cutoff_index: 5,
      summary_message: { content: "body" },
      file_path: "/conversation_history/tid.md",
    });
    expect(ev).toEqual({
      cutoffIndex: 5,
      content: "body",
      filePath: "/conversation_history/tid.md",
    });
  });

  it("coerces non-string file_path to null", () => {
    const ev = parseSummarizationEvent({
      cutoff_index: 1,
      summary_message: { content: "body" },
      file_path: 42,
    });
    expect(ev?.filePath).toBeNull();
  });
});
