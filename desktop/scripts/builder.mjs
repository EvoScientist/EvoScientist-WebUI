// Runs electron-builder with the app's version taken from the root
// package.json (src/packaging.ts). Arguments pass through, e.g. `--dir` or
// `--publish never`. Runs after `npm run build` (it uses the compiled dist/).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import packaging from "../dist/packaging.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(
  readFileSync(join(root, "..", "package.json"), "utf8")
);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let args;
try {
  args = packaging.versionArgs(rootPkg.version);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const flag = packaging.releaseFlagProblem(pkg.evoscientist);
if (flag) {
  console.error(flag);
  process.exit(1);
}

const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
console.log(`electron-builder for version ${rootPkg.version}`);
const r = spawnSync(
  process.execPath,
  [cli, ...process.argv.slice(2), ...args],
  {
    cwd: root,
    stdio: "inherit",
  }
);
process.exit(r.status ?? 1);
