// Prints a release body with the desktop section (release-notes.md, filled)
// in place: node scripts/release-notes.mjs <body file> <installer>
// Runs after `npm run build` (it uses the compiled dist/).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import notes from "../dist/releaseNotes.js";
import versions from "../dist/versions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [bodyFile, installer] = process.argv.slice(2);
if (!bodyFile || !installer) {
  console.error("usage: release-notes.mjs <body file> <installer>");
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const rootPkg = JSON.parse(
  readFileSync(join(root, "..", "package.json"), "utf8")
);
const range = pkg.evoscientist.coreRange;
const section = notes.renderNotes(
  readFileSync(join(root, "release-notes.md"), "utf8"),
  {
    version: rootPkg.version,
    sha256: createHash("sha256").update(readFileSync(installer)).digest("hex"),
    coreRange: range,
    installVersion: versions.installVersion(range) ?? "",
  }
);
process.stdout.write(notes.mergeNotes(readFileSync(bodyFile, "utf8"), section));
