import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  hasExpertFile,
  isInstalledExpert,
  listPinnableSkills,
  readSkillFileIn,
  declaresSkillType,
  stripExpertFrontmatter,
  EXPERT_FILENAME,
} from "./skills";

// An expert is declared structurally: a sibling EXPERT.md in the skill's own
// directory. The catalog already holds the repo's whole file tree, so this
// costs no extra request — and it matches what the backend classifies on.
describe("hasExpertFile", () => {
  const blob = (path: string) => ({ path });

  it("recognises a skill that ships an EXPERT.md", () => {
    expect(
      hasExpertFile("paper-review", [
        blob("skills/paper-review/SKILL.md"),
        blob("skills/paper-review/EXPERT.md"),
      ])
    ).toBe(true);
  });

  it("treats a skill without one as an ordinary skill", () => {
    expect(
      hasExpertFile("paper-writing", [blob("skills/paper-writing/SKILL.md")])
    ).toBe(false);
  });

  it("does not count an EXPERT.md belonging to another skill", () => {
    expect(
      hasExpertFile("paper-writing", [blob("skills/paper-review/EXPERT.md")])
    ).toBe(false);
  });

  it("requires the file to sit beside SKILL.md, not deeper in the tree", () => {
    expect(
      hasExpertFile("paper-review", [
        blob("skills/paper-review/references/EXPERT.md"),
      ])
    ).toBe(false);
  });
});

describe("isInstalledExpert", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "evo-skill-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recognises an installed skill that ships an EXPERT.md", async () => {
    await fs.writeFile(join(dir, "SKILL.md"), "# Skill");
    await fs.writeFile(join(dir, EXPERT_FILENAME), "## Persona");
    expect(await isInstalledExpert(dir)).toBe(true);
  });

  it("treats a skill dir without one as an ordinary skill", async () => {
    await fs.writeFile(join(dir, "SKILL.md"), "# Skill");
    expect(await isInstalledExpert(dir)).toBe(false);
  });

  it("does not mistake a directory named EXPERT.md for an actor definition", async () => {
    await fs.mkdir(join(dir, EXPERT_FILENAME));
    expect(await isInstalledExpert(dir)).toBe(false);
  });

  it("reports false for a skill dir that is not there at all", async () => {
    expect(await isInstalledExpert(join(dir, "missing"))).toBe(false);
  });
});

describe("readSkillFileIn", () => {
  let tier: string;
  let outside: string;

  beforeEach(async () => {
    tier = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evo-tier-")));
    outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evo-out-")));
    await fs.mkdir(join(tier, "paper-review"));
  });

  afterEach(async () => {
    await fs.rm(tier, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("reads a file from inside the tier", async () => {
    await fs.writeFile(
      join(tier, "paper-review", EXPERT_FILENAME),
      "## Persona"
    );
    expect(await readSkillFileIn(tier, "paper-review", EXPERT_FILENAME)).toBe(
      "## Persona"
    );
  });

  it("returns null when the file is absent", async () => {
    expect(await readSkillFileIn(tier, "paper-review", EXPERT_FILENAME)).toBe(
      null
    );
  });

  it("refuses a symlink that escapes the tier", async () => {
    // Skill dirs are user-writable, so a symlinked EXPERT.md must never be
    // allowed to read arbitrary files off disk.
    const secret = join(outside, "secret.md");
    await fs.writeFile(secret, "top secret");
    await fs.symlink(secret, join(tier, "paper-review", EXPERT_FILENAME));
    expect(await readSkillFileIn(tier, "paper-review", EXPERT_FILENAME)).toBe(
      null
    );
  });

  it("follows a symlink that stays inside the tier", async () => {
    const target = join(tier, "shared.md");
    await fs.writeFile(target, "shared persona");
    await fs.symlink(target, join(tier, "paper-review", EXPERT_FILENAME));
    expect(await readSkillFileIn(tier, "paper-review", EXPERT_FILENAME)).toBe(
      "shared persona"
    );
  });
});

describe("stripExpertFrontmatter", () => {
  it("returns the persona as-is when there is no frontmatter", () => {
    // The contract says EXPERT.md carries none, so this is the normal path.
    expect(stripExpertFrontmatter("## Persona\n\nYou are a reviewer.\n")).toBe(
      "## Persona\n\nYou are a reviewer."
    );
  });

  it("strips a frontmatter block a skill added anyway", () => {
    expect(
      stripExpertFrontmatter("---\nname: x\n---\n## Persona\n\nYou review.\n")
    ).toBe("## Persona\n\nYou review.");
  });

  it("keeps a body that merely opens with a horizontal rule", () => {
    expect(stripExpertFrontmatter("---\n\n## Persona\n")).toBe(
      "---\n\n## Persona"
    );
  });
});

// `metadata.type` is a UI-only classification: the backend never reads it
// (skills_manager calls it "index-facing only"). It decides whether an expert
// ALSO belongs in the skills gallery — nothing about dispatch.
describe("declaresSkillType", () => {
  const fm = (body: string) => `---\n${body}\n---\n# Doc\n`;

  it("treats a skill that lists both as belonging in both galleries", () => {
    expect(
      declaresSkillType(fm("name: x\nmetadata:\n  type: [skill, expert]"))
    ).toBe(true);
  });

  it("keeps an expert-only skill out of the skills gallery", () => {
    expect(declaresSkillType(fm("name: x\nmetadata:\n  type: [expert]"))).toBe(
      false
    );
  });

  it("defaults to yes when no type is declared", () => {
    // Most skills never write this field; an expert must not vanish from the
    // gallery just because its author left it out.
    expect(declaresSkillType(fm("name: x\ndescription: y"))).toBe(true);
    expect(declaresSkillType(fm("name: x\nmetadata:\n  version: '1.0'"))).toBe(
      true
    );
    expect(declaresSkillType("# No frontmatter at all")).toBe(true);
  });

  it("reads a single unbracketed value", () => {
    expect(declaresSkillType(fm("metadata:\n  type: expert"))).toBe(false);
    expect(declaresSkillType(fm("metadata:\n  type: skill"))).toBe(true);
  });

  it("tolerates quotes and odd spacing", () => {
    expect(
      declaresSkillType(fm('metadata:\n  type: [ "expert" , "skill" ]'))
    ).toBe(true);
    expect(declaresSkillType(fm("metadata:\n  type:  ['expert']"))).toBe(false);
  });

  it("treats an explicitly empty list as a declaration, not an omission", () => {
    // Writing `type: []` says "neither" — quite different from never having
    // written the field, which means "no opinion, show it everywhere".
    expect(declaresSkillType(fm("metadata:\n  type: []"))).toBe(false);
  });

  it("reads the block-sequence spelling", () => {
    // Valid YAML, and the form an editor is as likely to produce as the
    // inline one.
    expect(declaresSkillType(fm("metadata:\n  type:\n    - expert"))).toBe(
      false
    );
    expect(
      declaresSkillType(fm("metadata:\n  type:\n    - skill\n    - expert"))
    ).toBe(true);
  });

  it("ignores a type nested deeper than metadata's own keys", () => {
    // `metadata.other.type` is somebody else's field, not the index's.
    expect(
      declaresSkillType(
        fm("metadata:\n  author: me\n  other:\n    type: expert")
      )
    ).toBe(true);
  });

  it("ignores a type outside the metadata block", () => {
    // A top-level `type:` is not the field the index uses.
    expect(declaresSkillType(fm("type: expert\nname: x"))).toBe(true);
  });
});

// The `/` menu offers what the backend can pin by name, as its own index finds
// it (EvoScientist `skills_manager._build_skill_index` over the merged skills
// folder, `backends.MergedSkillsBackend`).
describe("listPinnableSkills", () => {
  let workspace: string;
  let global: string;
  let outside: string;
  const write = async (
    tier: string,
    dir: string,
    frontmatter: string | null
  ) => {
    await fs.mkdir(join(tier, dir), { recursive: true });
    await fs.writeFile(
      join(tier, dir, "SKILL.md"),
      frontmatter === null
        ? "# No frontmatter\n"
        : `---\n${frontmatter}\n---\n# Body\n`
    );
  };
  const list = async (tiers?: { workspace: string | null; global: string }) =>
    (await listPinnableSkills(tiers ?? { workspace, global })).map((s) => [
      s.name,
      s.description,
      s.source,
    ]);

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evo-ws-")));
    global = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evo-gl-")));
    outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evo-out-")));
  });
  afterEach(async () => {
    for (const dir of [workspace, global, outside]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("lists both tiers by frontmatter name, sorted", async () => {
    await write(
      global,
      "paper-writing",
      "name: paper-writing\ndescription: Write papers"
    );
    await write(
      global,
      "review",
      'name: "paper-review"\ndescription: "Review papers"'
    );
    await write(
      workspace,
      "house",
      "name: house-style\ndescription: Our style"
    );
    expect(await list()).toEqual([
      ["house-style", "Our style", "workspace"],
      ["paper-review", "Review papers", "global"],
      ["paper-writing", "Write papers", "global"],
    ]);
  });

  it("lets a workspace folder hide the global one of the same name", async () => {
    await write(
      global,
      "paper-writing",
      "name: paper-writing\ndescription: Global"
    );
    await write(
      workspace,
      "paper-writing",
      "name: paper-writing-v2\ndescription: Ours"
    );
    expect(await list()).toEqual([["paper-writing-v2", "Ours", "workspace"]]);
  });

  it("reads the global SKILL.md when the workspace folder has none", async () => {
    await write(
      global,
      "paper-writing",
      "name: paper-writing\ndescription: Global"
    );
    await fs.mkdir(join(workspace, "paper-writing"));
    expect(await list()).toEqual([["paper-writing", "Global", "global"]]);
  });

  it("gives a name declared twice to the later folder", async () => {
    await write(global, "a-first", "name: same\ndescription: First");
    await write(global, "b-second", "name: same\ndescription: Second");
    // The backend's folder paths end in "/", which sorts after "-": its
    // "paper-x/" comes before "paper/".
    await write(global, "paper", "name: other\ndescription: In paper");
    await write(global, "paper-x", "name: other\ndescription: In paper-x");
    // By code point, as Python sorts: U+FF21 before U+1F600 (UTF-16 units
    // would put the emoji's surrogates first).
    await write(global, "\uff21", "name: wide\ndescription: Fullwidth A");
    await write(global, "\u{1f600}", "name: wide\ndescription: Emoji");
    expect(await list()).toEqual([
      ["other", "In paper", "global"],
      ["same", "Second", "global"],
      ["wide", "Emoji", "global"],
    ]);
  });

  it("leaves out what the backend can't pin", async () => {
    await write(global, "no-frontmatter", null);
    await write(global, "no-name", "description: Something");
    await write(global, "no-description", "name: no-description");
    await write(global, "blank", 'name: blank\ndescription: "  "');
    await write(global, "upper", "name: Paper\ndescription: Upper case");
    await write(global, "underscore", "name: pa_per\ndescription: Underscore");
    // Only text makes a name: the backend reads these as "True" and "None".
    await write(global, "boolean", "name: true\ndescription: A boolean");
    await write(global, "null", "name:\ndescription: No name");
    // Python's strip() keeps a byte order mark, which no pin name has.
    await write(global, "feff", 'name: "\ufeffwide"\ndescription: Marked');
    await write(
      global,
      "long",
      `name: ${"a".repeat(65)}\ndescription: Too long`
    );
    // The WebUI's own /model command wins over a skill by that name.
    await write(global, "model", "name: model\ndescription: Shadowed");
    await fs.writeFile(join(global, "stray.md"), "---\nname: stray\n---\n");
    await write(
      global,
      "ok",
      `name: ${"a".repeat(64)}\ndescription: Just fits`
    );
    expect(await list()).toEqual([["a".repeat(64), "Just fits", "global"]]);
  });

  it("skips a frontmatter YAML can't read, as the backend does", async () => {
    // A colon and space inside a plain value, a reserved first character, a
    // broken line elsewhere, an unknown tag, and a list instead of fields.
    await write(
      global,
      "colon",
      "name: colon\ndescription: Our style: short sentences"
    );
    await write(global, "at", "name: at\ndescription: @mention people");
    await write(global, "broken", "name: broken\ndescription: Fine\ntags: [a");
    await write(global, "tagged", "name: tagged\ndescription: !custom x");
    await write(global, "list", "- name: list\n- description: A list");
    await write(global, "ok", "name: ok\ndescription: Fine");
    expect(await list()).toEqual([["ok", "Fine", "global"]]);
  });

  it("reads values the way YAML does", async () => {
    await write(
      global,
      "commented",
      "name: evo-memory # a note\ndescription: Remember # this too"
    );
    await write(
      global,
      "quoted",
      "name: 'quoted' # a note\ndescription: \"Use # with care\" # this too"
    );
    await write(
      global,
      "folded",
      "name: folded\ndescription: >-\n  Spread over\n  two lines"
    );
    await write(
      global,
      "literal",
      "name: literal\ndescription: |\n  Line one\n  Line two"
    );
    await write(
      global,
      "plain",
      "name: plain\ndescription: Goes on\n  over two lines"
    );
    // The backend reads an empty value as "None": indexed, shown blank here.
    await write(global, "empty", "name: empty\ndescription:");
    // A date stays the text Python's str() of it reads.
    await write(global, "dated", "name: 2026-10-16\ndescription: Dated");
    await write(
      global,
      "repeated",
      "name: first\nname: repeated\ndescription: The last one counts"
    );
    await write(
      global,
      ".hidden",
      "name: hidden\ndescription: In a dot folder"
    );
    expect(await list()).toEqual([
      ["2026-10-16", "Dated", "global"],
      ["empty", "", "global"],
      ["evo-memory", "Remember", "global"],
      ["folded", "Spread over two lines", "global"],
      ["hidden", "In a dot folder", "global"],
      ["literal", "Line one\nLine two", "global"],
      ["plain", "Goes on over two lines", "global"],
      ["quoted", "Use # with care", "global"],
      ["repeated", "The last one counts", "global"],
    ]);
  });

  it("finds the frontmatter fence the way the backend does", async () => {
    const raw = async (dir: string, content: string | Buffer) => {
      await fs.mkdir(join(global, dir));
      await fs.writeFile(join(global, dir, "SKILL.md"), content);
    };
    await raw(
      "crlf",
      "---  \r\nname: crlf\r\ndescription: Windows lines\r\n---  \r\n# Body\r\n"
    );
    await raw(
      "blank-first",
      "---\n\nname: blank-first\ndescription: A blank line first\n---\n"
    );
    await raw(
      "four-dashes",
      "---\nname: four-dashes\ndescription: Not closed\n----\n"
    );
    await raw("unended", "---\nname: unended\ndescription: Ends at it\n---");
    await raw(
      "bom",
      "\ufeff---\nname: bom\ndescription: Byte order mark\n---\n"
    );
    // Blanks as Python's \\s reads them: U+FEFF isn't one, U+0085 is.
    await raw(
      "feff-fence",
      "---\ufeff\nname: feff-fence\ndescription: Not a blank\n---\n"
    );
    await raw(
      "nel-fence",
      "---\u0085\nname: nel-fence\ndescription: A blank\n---\n"
    );
    await raw(
      "latin1",
      Buffer.concat([
        Buffer.from("---\nname: latin1\ndescription: Caf"),
        Buffer.from([0xe9]),
        Buffer.from("\n---\n"),
      ])
    );
    expect(await list()).toEqual([
      ["blank-first", "A blank line first", "global"],
      ["crlf", "Windows lines", "global"],
      ["nel-fence", "A blank", "global"],
    ]);
  });

  it("reads a frontmatter past the first 64 KB, as the backend does", async () => {
    const notes = "x".repeat(70_000);
    await write(
      global,
      "long",
      `name: long\ndescription: Past 64 KB\nnotes: ${notes}`
    );
    expect(await list()).toEqual([["long", "Past 64 KB", "global"]]);
  });

  it("skips a SKILL.md that leads out of its tier", async () => {
    await write(outside, "secret", "name: secret\ndescription: Outside");
    await fs.symlink(join(outside, "secret"), join(global, "secret"));
    await fs.mkdir(join(global, "linked-file"));
    await fs.symlink(
      join(outside, "secret", "SKILL.md"),
      join(global, "linked-file", "SKILL.md")
    );
    expect(await list()).toEqual([]);
  });

  it("skips a SKILL.md too big for the backend, without falling back", async () => {
    await write(global, "big", "name: big\ndescription: Global copy");
    await write(workspace, "big", "name: big\ndescription: Too big");
    await fs.truncate(join(workspace, "big", "SKILL.md"), 10 * 1024 * 1024 + 1);
    expect(await list()).toEqual([]);
  });

  it("reads a SKILL.md of exactly 10 MiB, as the backend does", async () => {
    await write(global, "edge", "name: edge\ndescription: At the limit");
    await fs.truncate(join(global, "edge", "SKILL.md"), 10 * 1024 * 1024);
    expect(await list()).toEqual([["edge", "At the limit", "global"]]);
  });

  it("keeps the first 1024 characters of a description, as the agent sees it", async () => {
    const emoji = "\u{1f600}";
    await write(
      global,
      "wordy",
      `name: wordy\ndescription: ${emoji.repeat(1500)}`
    );
    expect(await list()).toEqual([["wordy", emoji.repeat(1024), "global"]]);
  });

  it("doesn't wait on a SKILL.md that isn't a regular file", async () => {
    await fs.mkdir(join(global, "pipe"));
    execFileSync("mkfifo", [join(global, "pipe", "SKILL.md")]);
    await write(global, "ok", "name: ok\ndescription: Fine");
    expect(await list()).toEqual([["ok", "Fine", "global"]]);
  });

  it("stays quick on a long run of spaces inside a value", async () => {
    const value = `x${" ".repeat(60_000)}y`;
    await write(global, "spaces", `name: spaces\ndescription: ${value}`);
    const started = performance.now();
    // Stripped whole, then cut to what the agent sees.
    expect(await list()).toEqual([["spaces", value.slice(0, 1024), "global"]]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("stays quick on a long run of blank lines", async () => {
    await fs.mkdir(join(global, "blank"));
    await fs.writeFile(
      join(global, "blank", "SKILL.md"),
      `---${"\n".repeat(150_000)}`
    );
    const started = performance.now();
    expect(await list()).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads the global tier alone when there is no workspace", async () => {
    await write(
      global,
      "evo-memory",
      "name: evo-memory\ndescription: Remember"
    );
    expect(await list({ workspace: null, global })).toEqual([
      ["evo-memory", "Remember", "global"],
    ]);
    expect(
      await list({
        workspace: join(workspace, "missing"),
        global: join(global, "missing"),
      })
    ).toEqual([]);
  });
});
