// electron-builder's beforePack hook: refuses to package without the core's
// install scripts for the version the app installs (npm run pack downloads
// them first; a bare `electron-builder` run does not).
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { coreScriptsProblem } = require("../dist/coreScripts.js");
const { installVersion } = require("../dist/versions.js");

module.exports = async function beforePack() {
  const root = join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = installVersion(pkg.evoscientist.coreRange);
  const problem = version
    ? coreScriptsProblem(join(root, "core-scripts"), version)
    : `coreRange ${pkg.evoscientist.coreRange} has no single >= clause`;
  if (problem) throw new Error(`The core's install scripts: ${problem}`);
};
