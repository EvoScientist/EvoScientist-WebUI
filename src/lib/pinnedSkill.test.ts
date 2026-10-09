import { describe, expect, it } from "vitest";
import type { Message } from "@langchain/langgraph-sdk";
import {
  pinnedSkillBody,
  pinnedSkillDescription,
  pinnedSkillName,
} from "./pinnedSkill";

const human = (additional_kwargs?: Record<string, unknown>): Message =>
  ({
    id: "p1",
    type: "human",
    content:
      '<skill name="paper-review" path="/skills/paper-review">...</skill>',
    additional_kwargs,
  } as unknown as Message);

describe("pinnedSkillName", () => {
  it("returns the skill name of a pinned-skill human message", () => {
    const message = human({
      lc_source: "pinned_skill",
      skill: { name: "paper-review", path: "/skills/paper-review" },
    });
    expect(pinnedSkillName(message)).toBe("paper-review");
  });

  it('falls back to "unknown" when the marker has no usable name', () => {
    expect(pinnedSkillName(human({ lc_source: "pinned_skill" }))).toBe(
      "unknown"
    );
    expect(
      pinnedSkillName(human({ lc_source: "pinned_skill", skill: {} }))
    ).toBe("unknown");
    expect(
      pinnedSkillName(human({ lc_source: "pinned_skill", skill: { name: "" } }))
    ).toBe("unknown");
    expect(
      pinnedSkillName(human({ lc_source: "pinned_skill", skill: { name: 7 } }))
    ).toBe("unknown");
    expect(
      pinnedSkillName(human({ lc_source: "pinned_skill", skill: "nope" }))
    ).toBe("unknown");
  });

  it("returns null for a human message the user typed", () => {
    expect(pinnedSkillName(human())).toBeNull();
    expect(pinnedSkillName(human({}))).toBeNull();
    expect(
      pinnedSkillName(human({ skill: { name: "paper-review" } }))
    ).toBeNull();
  });

  it("returns null for other harness-tagged human messages", () => {
    expect(pinnedSkillName(human({ lc_source: "summarization" }))).toBeNull();
  });

  it("returns null for non-human messages even when tagged", () => {
    const ai = {
      id: "a1",
      type: "ai",
      content: "done",
      additional_kwargs: {
        lc_source: "pinned_skill",
        skill: { name: "paper-review" },
      },
    } as unknown as Message;
    expect(pinnedSkillName(ai)).toBeNull();
  });
});

describe("pinnedSkillBody", () => {
  it("strips the skill wrapper the backend adds", () => {
    const content =
      '<skill name="paper-review" path="/skills/paper-review/SKILL.md">\n# Paper Review\n\nScore the draft.\n</skill>';
    expect(pinnedSkillBody(content)).toBe("# Paper Review\n\nScore the draft.");
  });

  it("keeps a closing tag that appears inside the body", () => {
    const content =
      '<skill name="x" path="/skills/x/SKILL.md">\nUse `</skill>` to end.\n</skill>';
    expect(pinnedSkillBody(content)).toBe("Use `</skill>` to end.");
  });

  it("returns content without the wrapper as is", () => {
    expect(pinnedSkillBody("# Paper Review\n\nNo wrapper.")).toBe(
      "# Paper Review\n\nNo wrapper."
    );
    expect(pinnedSkillBody("")).toBe("");
  });

  it("keeps the indentation of the first body line", () => {
    const content =
      '<skill name="x" path="/skills/x/SKILL.md">\n    run --fast\n\n    run --slow\n</skill>';
    expect(pinnedSkillBody(content)).toBe("    run --fast\n\n    run --slow");
  });

  it("maps a wrapper around an empty body to an empty string", () => {
    expect(
      pinnedSkillBody('<skill name="x" path="/skills/x/SKILL.md">\n\n</skill>')
    ).toBe("");
  });

  it("stays fast on a very long run of blank lines", () => {
    const head = '<skill name="x" path="/skills/x/SKILL.md">\n';
    const blank = "\n".repeat(100_000);
    const closed = head + blank + "\n</skill>";
    const unclosed = head + blank;

    const start = performance.now();
    expect(pinnedSkillBody(closed)).toBe(blank);
    expect(pinnedSkillBody(unclosed)).toBe(unclosed);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("pinnedSkillDescription", () => {
  const pinned = (skill: unknown): Message =>
    ({
      id: "p1",
      type: "human",
      content: "<skill>x</skill>",
      additional_kwargs: { lc_source: "pinned_skill", skill },
    } as unknown as Message);

  it("returns the description of the pinned skill", () => {
    expect(
      pinnedSkillDescription(
        pinned({ name: "paper-review", description: "Self-review a draft" })
      )
    ).toBe("Self-review a draft");
  });

  it("returns null when the description is missing, empty or not a string", () => {
    expect(pinnedSkillDescription(pinned({ name: "paper-review" }))).toBeNull();
    expect(
      pinnedSkillDescription(pinned({ name: "paper-review", description: " " }))
    ).toBeNull();
    expect(
      pinnedSkillDescription(pinned({ name: "paper-review", description: 7 }))
    ).toBeNull();
    expect(pinnedSkillDescription(pinned("nope"))).toBeNull();
    expect(pinnedSkillDescription(human())).toBeNull();
  });
});
