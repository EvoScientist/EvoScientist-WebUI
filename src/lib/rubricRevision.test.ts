import { describe, expect, it } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import { isRubricRevision } from "./rubricRevision";

const message = (m: Record<string, unknown>) => m as unknown as Message;

describe("isRubricRevision", () => {
  it("takes the grader's feedback message", () => {
    expect(
      isRubricRevision(
        message({
          type: "human",
          name: "rubric_grader",
          content: "A grader reviewed your work and asked for revisions.",
          additional_kwargs: { lc_source: "rubric_grader" },
        })
      )
    ).toBe(true);
  });

  it.each([
    [{ type: "human", content: "x" }],
    [{ type: "human", name: "rubric_grader", content: "x" }],
    [
      {
        type: "ai",
        content: "x",
        additional_kwargs: { lc_source: "rubric_grader" },
      },
    ],
    [
      {
        type: "human",
        content: "x",
        additional_kwargs: { lc_source: "pinned_skill" },
      },
    ],
  ])("leaves %j alone", (m) => {
    expect(isRubricRevision(message(m))).toBe(false);
  });
});
