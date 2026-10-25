import { describe, expect, it } from "vitest";
import {
  GOAL_LEADS,
  composerLead,
  mayPin,
  oneSkill,
  pinLead,
  pinnedLead,
  previewLead,
} from "./composerChip";

const SKILLS: ReadonlySet<string> = new Set(["paper-review", "evo-memory"]);
const lead = (
  text: string,
  goalMode: "goal" | "amend" | null = null,
  skills: ReadonlySet<string> | null = SKILLS
) => composerLead(text, { skills, goalMode });
const skill = (name: string) => ({ kind: "skill" as const, name });

describe("composerLead", () => {
  it("shows a known skill once its word is followed by whitespace", () => {
    expect(lead("/paper-review hello")).toEqual({
      chip: skill("paper-review"),
      lead: "/paper-review ",
    });
    expect(lead("/paper-review")).toEqual({ chip: null, lead: "" });
    // One separator: what follows it stays in the box.
    expect(lead("/paper-review\n\nhi")).toEqual({
      chip: skill("paper-review"),
      lead: "/paper-review\n",
    });
    expect(lead("/paper-review   ").lead).toBe("/paper-review ");
    // Python's whitespace, as the backend splits the words.
    expect(lead("/paper-review　hi").lead).toBe("/paper-review　");
  });

  it("shows no chip for an unknown skill or before the skills are read", () => {
    expect(lead("/unknown hi").chip).toBeNull();
    expect(lead("/paper-review hi", null, null).chip).toBeNull();
  });

  it("shows only the first leading skill", () => {
    expect(lead("/paper-review /evo-memory x")).toEqual({
      chip: skill("paper-review"),
      lead: "/paper-review ",
    });
  });

  // Leading whitespace is no word (see "composerLead after leading
  // whitespace" below); another word ahead of it is.
  it("needs the skill's word first, as written", () => {
    expect(lead("see /paper-review hi").chip).toBeNull();
    expect(lead("/Paper-review hi").chip).toBeNull();
  });

  it("never shows a command word as a skill", () => {
    const skills = new Set(["goal", "model"]);
    const none = { chip: null, lead: "" };
    expect(composerLead("/goal x", { skills, goalMode: null })).toEqual(none);
    expect(composerLead("/model x", { skills, goalMode: null })).toEqual(none);
    // Where goals don't run, "goal" is a skill like any other.
    expect(
      composerLead("/goal x", {
        skills,
        goalMode: null,
        commands: new Set(["model"]),
      }).chip
    ).toEqual(skill("goal"));
  });

  it("shows goal and amend chips only in their mode, while the text starts with the lead", () => {
    expect(lead("/goal write x", "goal")).toEqual({
      chip: { kind: "goal" },
      lead: GOAL_LEADS.goal,
    });
    expect(lead("/goal ", "goal").chip).toEqual({ kind: "goal" });
    expect(lead("/goal amend tighten it", "amend")).toEqual({
      chip: { kind: "amend" },
      lead: "/goal amend ",
    });
    // Out of its mode, typed: no chip.
    expect(lead("/goal write x").chip).toBeNull();
    expect(lead("/goal amend x").chip).toBeNull();
    // A mode whose text went: what the text has instead.
    expect(lead("write x", "goal").chip).toBeNull();
    expect(lead("/paper-review hi", "amend").chip).toEqual(
      skill("paper-review")
    );
  });
});

describe("previewLead", () => {
  const preview = (text: string, goals = true) =>
    previewLead(text, { skills: SKILLS, goals });

  it("reads a queued text the way Enter reads it", () => {
    expect(preview("/goal write x")).toEqual({
      chip: { kind: "goal" },
      lead: "/goal ",
    });
    expect(preview("/goal amend fix it")).toEqual({
      chip: { kind: "amend" },
      lead: "/goal amend ",
    });
    expect(preview("/goal write x", false).chip).toBeNull();
    expect(preview("/goal pause").chip).toBeNull();
    expect(preview("/goal").chip).toBeNull();
    expect(preview("/paper-review hi")).toEqual({
      chip: skill("paper-review"),
      lead: "/paper-review ",
    });
  });

  it("covers the spacing before a goal's text", () => {
    expect(preview("/goal \t write x").lead).toBe("/goal \t ");
    expect(preview("/goal AMEND   fix").lead).toBe("/goal AMEND   ");
  });
});

// A sent message: the skills the backend pinned for it (its markers), drawn
// as chips while they lead the text, in order.
describe("pinnedLead", () => {
  it("takes the pinned skills that lead the text, in order", () => {
    expect(
      pinnedLead("/paper-review /evo-memory hi", ["paper-review", "evo-memory"])
    ).toEqual({
      skills: ["paper-review", "evo-memory"],
      rest: "hi",
    });
  });

  it("stops at the first word that wasn't pinned", () => {
    expect(pinnedLead("/x /paper-review hi", ["paper-review"])).toEqual({
      skills: [],
      rest: "/x /paper-review hi",
    });
    expect(pinnedLead("/paper-review /x hi", ["paper-review"])).toEqual({
      skills: ["paper-review"],
      rest: "/x hi",
    });
  });

  it("leaves a text without pins as it is", () => {
    expect(pinnedLead("/paper-review hi", [])).toEqual({
      skills: [],
      rest: "/paper-review hi",
    });
  });

  it("takes a pinned word that is the whole text, and one led by whitespace", () => {
    expect(pinnedLead("/paper-review", ["paper-review"])).toEqual({
      skills: ["paper-review"],
      rest: "",
    });
    expect(pinnedLead(" /paper-review\thi", ["paper-review"])).toEqual({
      skills: ["paper-review"],
      rest: "hi",
    });
  });

  it("needs the whole word: a longer one isn't the pin", () => {
    expect(pinnedLead("/paper-reviewer hi", ["paper-review"])).toEqual({
      skills: [],
      rest: "/paper-reviewer hi",
    });
  });
});

// Codex, checkpoint B: the composer sends its text trimmed and the backend
// splits on whitespace, so a pin after leading whitespace still pins.
describe("composerLead after leading whitespace", () => {
  it("takes the pin, the whitespace in its lead", () => {
    expect(lead(" /paper-review hi")).toEqual({
      chip: skill("paper-review"),
      lead: " /paper-review ",
    });
    expect(lead("\n\t/paper-review\u3000hi")).toEqual({
      chip: skill("paper-review"),
      lead: "\n\t/paper-review\u3000",
    });
  });

  it("still needs the whole word and a pin", () => {
    expect(lead("  /paper-review")).toEqual({ chip: null, lead: "" });
    expect(lead("  /unknown hi")).toEqual({ chip: null, lead: "" });
    expect(lead("  hi /paper-review x")).toEqual({ chip: null, lead: "" });
  });
});

// One skill a message: a change that leads with several keeps the last, as a
// pick or a typed skill replaces the chip (Codex C2, agent #9).
describe("oneSkill", () => {
  const opts = { skills: SKILLS, goalMode: null };

  it("keeps the last of several leading skills", () => {
    expect(oneSkill("/paper-review /evo-memory hi", opts)).toBe(
      "/evo-memory hi"
    );
    expect(oneSkill(" /evo-memory  /paper-review", opts)).toBe(
      " /evo-memory  /paper-review"
    );
    // What the earlier skill's lead didn't take stays.
    expect(oneSkill(" /evo-memory  /paper-review x", opts)).toBe(
      " /paper-review x"
    );
  });

  it("leaves one skill, none, a word that isn't installed and goal mode as they are", () => {
    expect(oneSkill("/paper-review hi /evo-memory", opts)).toBe(
      "/paper-review hi /evo-memory"
    );
    expect(oneSkill("hi", opts)).toBe("hi");
    expect(oneSkill("/paper-review /unknown hi", opts)).toBe(
      "/paper-review /unknown hi"
    );
    expect(
      oneSkill("/goal /paper-review /evo-memory x", {
        skills: SKILLS,
        goalMode: "goal",
      })
    ).toBe("/goal /paper-review /evo-memory x");
  });
});

// A queued row reads command words as the composer does: "goal" is one while
// goal support is unknown.
describe("previewLead and command words", () => {
  const skills: ReadonlySet<string> = new Set(["goal", "paper-review"]);

  it("never reads a command word it is given as a skill", () => {
    expect(
      previewLead("/goal x", {
        skills,
        goals: false,
        commands: new Set(["model", "goal"]),
      }).chip
    ).toBeNull();
    // Without them, "goal" is a skill where goals don't run.
    expect(previewLead("/goal x", { skills, goals: false }).chip).toEqual(
      skill("goal")
    );
  });
});

// Codex, checkpoint B confirm round: what a text's first word is, before (and
// whatever) the skill names say.
describe("mayPin and pinLead", () => {
  it("sees a leading / after Python whitespace", () => {
    expect(mayPin("/x")).toBe(true);
    expect(mayPin(" \u0085\t/x")).toBe(true);
    expect(mayPin(" x /y")).toBe(false);
    expect(mayPin("")).toBe(false);
  });

  it("takes a leading /word as a pin would, whatever is installed", () => {
    expect(pinLead("/paper-review /goal x")).toEqual({
      name: "paper-review",
      lead: "/paper-review ",
    });
    expect(pinLead("\u0085/any-word hi")).toEqual({
      name: "any-word",
      lead: "\u0085/any-word ",
    });
    // A command's word, a word that isn't a pin, and a word not yet ended
    // aren't.
    expect(pinLead("/goal x")).toBeNull();
    expect(pinLead("/Paper x")).toBeNull();
    expect(pinLead("/paper-review")).toBeNull();
  });
});

// Agent, confirm round B: the lead is read every render, so the whitespace
// ahead of a pin is read up to a bound (a pasted log of blank lines cost
// 12 ms a call).
describe("the whitespace ahead of a pin", () => {
  it("is read up to 1,024 characters", () => {
    expect(pinLead(" ".repeat(1024) + "/paper-review hi")?.name).toBe(
      "paper-review"
    );
    expect(pinLead(" ".repeat(1025) + "/paper-review hi")).toBeNull();
    expect(mayPin("\n".repeat(1025) + "/x")).toBe(false);
    expect(
      pinnedLead("\n".repeat(1025) + "/paper-review hi", ["paper-review"])
        .skills
    ).toEqual([]);
  });
});
