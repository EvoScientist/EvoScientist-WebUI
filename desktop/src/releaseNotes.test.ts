import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { END, START, mergeNotes, renderNotes } from "./releaseNotes";

const values = {
  version: "0.4.3",
  sha256: "ab".repeat(32),
  coreRange: ">=0.4.0,<0.5",
  installVersion: "0.4.0",
};

describe("renderNotes", () => {
  it("fills the placeholders and refuses an unknown one", () => {
    expect(renderNotes("v{{version}} {{sha256}}", values)).toBe(
      `v0.4.3 ${"ab".repeat(32)}`
    );
    expect(() => renderNotes("{{shasum}}", values)).toThrow(/shasum/);
    // Inherited names are not values.
    expect(() => renderNotes("{{constructor}}", values)).toThrow(/constructor/);
  });

  it("fills the repository's template completely", () => {
    const template = readFileSync(
      join(__dirname, "..", "release-notes.md"),
      "utf8"
    );
    const text = renderNotes(template, values);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain(values.sha256);
    expect(text).toContain("`>=0.4.0,<0.5`");
    expect(text).toContain("More info");
    expect(text).toContain("Run anyway");
    expect(text).toContain("%LOCALAPPDATA%\\Programs\\EvoScientist");
    expect(text).toContain("tool uninstall EvoScientist");
    // Plain hyphens only in release copy.
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("mergeNotes", () => {
  it("appends the section after the maintainers' notes", () => {
    expect(mergeNotes("# 0.4.3\n\nFixes.\n", "Desktop")).toBe(
      `# 0.4.3\n\nFixes.\n\n${START}\nDesktop\n${END}\n`
    );
    expect(mergeNotes("", "Desktop")).toBe(`${START}\nDesktop\n${END}\n`);
  });

  it("replaces the section of an earlier run and keeps the text around it", () => {
    const once = mergeNotes("Notes.", "old");
    const twice = mergeNotes(`${once}\nAdded later.`, "new");
    expect(twice).toBe(`Notes.\n\n${START}\nnew\n${END}\n\nAdded later.`);
    expect(twice.split(START)).toHaveLength(2);
  });
});
