import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  END,
  START,
  joinSections,
  mergeNotes,
  renderNotes,
  templateFor,
} from "./releaseNotes";

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

  it("fills the macOS template completely", () => {
    // A Windows checkout has CRLF line ends.
    const template = readFileSync(
      join(__dirname, "..", templateFor("EvoScientist-arm64.dmg")),
      "utf8"
    ).replace(/\r\n/g, "\n");
    const text = renderNotes(template, values);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toMatch(/^## Desktop app for macOS\n/);
    expect(text).toContain("`EvoScientist-arm64.dmg`");
    expect(text).toContain(values.sha256);
    expect(text).toContain("`>=0.4.0,<0.5`");
    expect(text).toContain("installs EvoScientist 0.4.0");
    // Who it is for, and what to do where the app cannot update itself.
    expect(text).toContain("Apple silicon");
    expect(text).toContain("does not run on Intel Macs");
    expect(text).toContain("macOS 13");
    expect(text).toContain(
      "https://github.com/EvoScientist/EvoScientist-WebUI/releases/latest"
    );
    expect(text).toContain("~/Library/Application Support/EvoScientist");
    // What the app and the system's updater leave under ~/Library (seen in
    // a scratch home after an update).
    for (const left of [
      "~/Library/Caches/evoscientist-updater",
      "`Caches/com.evoscientist.desktop`",
      "`Caches/com.evoscientist.desktop.ShipIt`",
      "`HTTPStorages/com.evoscientist.desktop`",
      "`Preferences/com.evoscientist.desktop.plist`",
    ])
      expect(text, left).toContain(left);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("templateFor", () => {
  it("is the macOS template for the dmg, the Windows one otherwise", () => {
    expect(templateFor("EvoScientist-arm64.dmg")).toBe("release-notes-mac.md");
    expect(templateFor("release/EvoScientist-arm64.dmg")).toBe(
      "release-notes-mac.md"
    );
    expect(templateFor("EvoScientist-Setup.exe")).toBe("release-notes.md");
    expect(templateFor("release\\EvoScientist-Setup.exe")).toBe(
      "release-notes.md"
    );
  });
});

describe("joinSections", () => {
  it("puts one blank line between the sections", () => {
    expect(joinSections(["## Windows\n\nA.\n", "\n## macOS\n\nB.\n\n"])).toBe(
      "## Windows\n\nA.\n\n## macOS\n\nB."
    );
    expect(joinSections(["only\n"])).toBe("only");
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

  it("holds both platforms' sections in one block, replaced as one", () => {
    const both = joinSections(["## Windows", "## macOS"]);
    const once = mergeNotes("Notes.", both);
    expect(once).toBe(`Notes.\n\n${START}\n## Windows\n\n## macOS\n${END}\n`);
    // A re-run without the macOS files (its switch off) leaves no old one.
    const again = mergeNotes(once, joinSections(["## Windows"]));
    expect(again).toBe(`Notes.\n\n${START}\n## Windows\n${END}\n`);
    expect(again.split(START)).toHaveLength(2);
    expect(again.split(END)).toHaveLength(2);
  });
});
