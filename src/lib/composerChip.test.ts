import { describe, expect, it } from "vitest";
import {
  GOAL_LEADS,
  composerLead,
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

  it("needs the skill's word at the very start", () => {
    expect(lead(" /paper-review hi").chip).toBeNull();
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
