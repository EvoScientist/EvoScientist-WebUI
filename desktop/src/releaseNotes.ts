// The desktop section of a GitHub Release's notes, filled by the release
// workflow from one template per platform: release-notes.md for Windows
// (the installer's SHA-256, the core range, the SmartScreen steps, where the
// app goes and what uninstall leaves) and release-notes-mac.md for macOS
// (the dmg's SHA-256, which Macs it runs on, where the app cannot update
// itself). The platforms' sections sit together between two markers: in
// place of a marker pair the maintainers' notes already hold, else below
// them, so a re-run of the workflow replaces them instead of adding a
// second block.

export const START = "<!-- desktop-release-notes -->";
export const END = "<!-- /desktop-release-notes -->";

export interface NotesValues {
  version: string;
  sha256: string;
  coreRange: string;
  installVersion: string;
}

/** The template with its `{{name}}` placeholders filled; an unknown one is
 *  an error, so a typo never reaches a release. */
export function renderNotes(template: string, values: NotesValues): string {
  const map = values as unknown as Record<string, string>;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!Object.hasOwn(map, name))
      throw new Error(`unknown placeholder {{${name}}}`);
    return map[name];
  });
}

/** The template for a release file: the macOS one for the dmg, else the
 *  Windows one. */
export function templateFor(
  file: string
): "release-notes.md" | "release-notes-mac.md" {
  return file.toLowerCase().endsWith(".dmg")
    ? "release-notes-mac.md"
    : "release-notes.md";
}

/** The platforms' sections as one, in the order given. */
export function joinSections(sections: string[]): string {
  return sections.map((s) => s.trim()).join("\n\n");
}

/** The release body with the desktop section in place of an earlier one,
 *  else appended after the maintainers' text. */
export function mergeNotes(body: string, section: string): string {
  const block = `${START}\n${section.trim()}\n${END}`;
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start !== -1 && end > start)
    return body.slice(0, start) + block + body.slice(end + END.length);
  const text = body.trimEnd();
  return text ? `${text}\n\n${block}\n` : `${block}\n`;
}
