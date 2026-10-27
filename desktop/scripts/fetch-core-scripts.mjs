// Downloads the core's install scripts that the app bundles, for the core
// version it installs (the lower bound of `evoscientist.coreRange`), into
// core-scripts/. Fails, and so fails the build, when either is missing.
// Runs after `npm run build` (it uses the compiled dist/). Through a proxy:
// `node --use-env-proxy` reads HTTPS_PROXY / NO_PROXY.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import coreScripts from "../dist/coreScripts.js";
import versions from "../dist/versions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const range = pkg.evoscientist.coreRange;
const version = versions.installVersion(range);
if (!version) {
  console.error(
    `coreRange ${range} has no single >= clause: no version to install`
  );
  process.exit(1);
}
const outDir = join(root, "core-scripts");
try {
  const source = await coreScripts.fetchCoreScripts({ version, outDir });
  for (const [name, url] of Object.entries(source.files))
    console.log(`${name} <- ${url}`);
} catch (e) {
  // fetch() reports "fetch failed" and keeps the reason (DNS, proxy, TLS) in `cause`.
  const c = e instanceof Error ? e.cause : undefined;
  const cause = c
    ? ` (${[c.code, c.message].filter(Boolean).join(" ") || c})`
    : "";
  console.error(
    `Cannot download the core's install scripts: ${
      e instanceof Error ? e.message : e
    }${cause}`
  );
  process.exit(1);
}
