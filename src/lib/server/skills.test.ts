import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hasExpertFile,
  isInstalledExpert,
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
