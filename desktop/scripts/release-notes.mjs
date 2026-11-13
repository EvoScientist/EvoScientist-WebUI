// The desktop section of a release's notes:
//   node scripts/release-notes.mjs section <installer or dmg>
//     prints that platform's section, its template filled (release-notes.md
//     for the Windows installer, release-notes-mac.md for the dmg); runs
//     after `npm run build` (compiled dist/);
//   node scripts/release-notes.mjs merge <body file> <section file>...
//     prints the release body with those sections in place, in the order
//     given. It runs in the job that holds the release token, which runs no
//     npm code: it imports src/releaseNotes.ts itself (Node 24 strips the
//     types), not dist/.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, ...args] = process.argv.slice(2);

if (mode === "section" && args.length === 1) {
  const { default: notes } = await import("../dist/releaseNotes.js");
  const { default: versions } = await import("../dist/versions.js");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const rootPkg = JSON.parse(
    readFileSync(join(root, "..", "package.json"), "utf8")
  );
  const range = pkg.evoscientist.coreRange;
  const section = notes.renderNotes(
    readFileSync(join(root, notes.templateFor(args[0])), "utf8"),
    {
      version: rootPkg.version,
      sha256: createHash("sha256").update(readFileSync(args[0])).digest("hex"),
      coreRange: range,
      installVersion: versions.installVersion(range) ?? "",
    }
  );
  process.stdout.write(`${section.trim()}\n`);
} else if (mode === "merge" && args.length >= 2) {
  const { joinSections, mergeNotes } = await import("../src/releaseNotes.ts");
  const [body, ...sections] = args;
  process.stdout.write(
    mergeNotes(
      readFileSync(body, "utf8"),
      joinSections(sections.map((file) => readFileSync(file, "utf8")))
    )
  );
} else {
  console.error(
    "usage: release-notes.mjs section <installer or dmg>\n" +
      "       release-notes.mjs merge <body file> <section file>..."
  );
  process.exit(2);
}
