import { describe, expect, it } from "vitest";
import { applySkill, rankSkills, slashTokenAt } from "./slashMenu";

const at = (text: string, caret = text.length) => slashTokenAt(text, caret);

describe("slashTokenAt", () => {
  it("finds a `/name` being typed at the start of the message", () => {
    expect(at("/")).toEqual({ start: 0, end: 1, query: "", pinned: [] });
    expect(at("/pap")).toEqual({ start: 0, end: 4, query: "pap", pinned: [] });
    expect(at("  /pap")).toEqual({
      start: 2,
      end: 6,
      query: "pap",
      pinned: [],
    });
  });

  it("finds one after other `/name`s, which the backend pins together", () => {
    expect(at("/paper-writing /rev")).toEqual({
      start: 15,
      end: 19,
      query: "rev",
      pinned: ["paper-writing"],
    });
    expect(at("/a\n/b")).toMatchObject({ query: "b", pinned: ["a"] });
  });

  it("ignores a slash the backend wouldn't pin", () => {
    // After ordinary words: only the message's leading `/name`s pin.
    expect(at("please /pap")).toBeNull();
    expect(at("/paper-writing please /rev")).toBeNull();
    // Not a name: paths, upper case (the backend matches lower case only),
    // characters a name can't have.
    expect(at("/docs/a")).toBeNull();
    expect(at("/Paper")).toBeNull();
    expect(at("/pa_per")).toBeNull();
    expect(at("/x/")).toBeNull();
    // An earlier word that isn't a valid name ends the pins, and so does one
    // longer than the backend's 64 characters.
    expect(at("/Paper /rev")).toBeNull();
    expect(at(`/${"a".repeat(65)} /rev`)).toBeNull();
    expect(at(`/${"a".repeat(64)} /rev`)).toMatchObject({ query: "rev" });
  });

  it("splits words where the backend does", () => {
    // Python's split() takes U+0085 and U+001C to U+001F as spaces, and
    // U+FEFF (a pasted byte order mark) as part of the word.
    expect(at("\ufeff/pa")).toBeNull();
    expect(at("/a\ufeff /pa")).toBeNull();
    expect(at("/a\u0085/pa")).toMatchObject({ query: "pa", pinned: ["a"] });
    expect(at("/pa\u001f", 3)).toMatchObject({ query: "pa" });
  });

  it("leaves the WebUI's /model command alone", () => {
    expect(at("/model")).toBeNull();
    expect(at("/model /pa")).toBeNull();
    // Still a name being typed, and pins after other pins.
    expect(at("/mod")).toMatchObject({ query: "mod" });
    expect(at("/a /model")).toMatchObject({ query: "model", pinned: ["a"] });
  });

  it("stays quick after a long paste without spaces", () => {
    // A long run, then more typing: an end-anchored regex goes quadratic here.
    const pasted = `${"x".repeat(200_000)} a`;
    const huge = "x".repeat(10_000_000);
    const started = performance.now();
    expect(at(pasted)).toBeNull();
    expect(at(`/${pasted}`)).toBeNull();
    // It runs on every render: a huge word at the caret, or before it, stays
    // cheap.
    const hugeFirst = `${huge} /pa`;
    // A pasted log: many words, the last a `/word` at the caret.
    const log = `${"word ".repeat(400_000)}/pa`;
    for (let i = 0; i < 100; i++) {
      expect(at(huge)).toBeNull();
      expect(at(hugeFirst)).toBeNull();
      expect(at(log)).toBeNull();
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("needs the caret at the end of the word", () => {
    expect(at("/paper", 3)).toBeNull();
    expect(at("/pap rest", 4)).toEqual({
      start: 0,
      end: 4,
      query: "pap",
      pinned: [],
    });
    expect(at("hello", 5)).toBeNull();
    expect(at("", 0)).toBeNull();
  });
});

const skill = (name: string, description = "") => ({ name, description });

describe("rankSkills", () => {
  const skills = [
    skill("paper-review", "Review your own paper"),
    skill("paper-writing", "Write a paper section by section"),
    skill("research-survey", "Survey papers on a topic"),
    skill("evo-memory", "Remember what worked"),
  ];

  it("lists every skill for a bare slash, by name", () => {
    expect(rankSkills(skills, "", []).map((s) => s.name)).toEqual([
      "evo-memory",
      "paper-review",
      "paper-writing",
      "research-survey",
    ]);
  });

  it("puts name prefixes first, then names containing it, then descriptions", () => {
    const list = [
      skill("survey-helper"),
      skill("research-survey"),
      skill("ideas", "A survey of ideas"),
      skill("unrelated"),
    ];
    expect(rankSkills(list, "surv", []).map((s) => s.name)).toEqual([
      "survey-helper",
      "research-survey",
      "ideas",
    ]);
  });

  it("matches descriptions without regard to case", () => {
    const list = [skill("paper-graph", "Map the lineage of a paper")];
    expect(rankSkills(list, "map", []).map((s) => s.name)).toEqual([
      "paper-graph",
    ]);
  });

  it("matches without regard to case and leaves out pinned skills", () => {
    expect(rankSkills(skills, "PAPER", []).map((s) => s.name)).toEqual([
      "paper-review",
      "paper-writing",
      "research-survey",
    ]);
    expect(
      rankSkills(skills, "paper", ["paper-writing"]).map((s) => s.name)
    ).toEqual(["paper-review", "research-survey"]);
  });
});

describe("applySkill", () => {
  it("puts the name and a space in place of what was typed", () => {
    const token = at("/pap")!;
    expect(applySkill("/pap", token, "paper-writing")).toEqual({
      text: "/paper-writing ",
      caret: 15,
    });
  });

  it("keeps a newline that follows", () => {
    const token = slashTokenAt("/pa\nDraft the intro", 3)!;
    expect(applySkill("/pa\nDraft the intro", token, "paper-writing")).toEqual({
      text: "/paper-writing\nDraft the intro",
      caret: 15,
    });
  });

  it("keeps what follows, without doubling the space", () => {
    const token = slashTokenAt("/a /pap draft the intro", 7)!;
    expect(
      applySkill("/a /pap draft the intro", token, "paper-writing")
    ).toEqual({ text: "/a /paper-writing draft the intro", caret: 18 });
  });
});
