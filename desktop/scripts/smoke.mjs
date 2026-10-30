// The desktop smoke test (.github/workflows/desktop.yml), on an unpacked
// build (`npm run pack`), through the app's own code (dist/):
// 1. install the core with the bundled install script (`-Version <v> -NoSetup`);
// 2. `EvoSci setup --json --skip webui`;
// 3. `EvoSci --version --json`: the version asked for, inside the app's core
//    range, and its `webui_compat` accepts the bundled WebUI;
// 4. `EvoSci deploy --json` until `ready`;
// 5. the bundled UI server under the packaged executable with
//    ELECTRON_RUN_AS_NODE=1: `/` and one static asset answer 200.
// Usage: node scripts/smoke.mjs --core pinned|newest|<version> [--app <dir>]
//        node scripts/smoke.mjs --list   (the versions to test, as JSON: one
//        when the newest release inside the range is the pinned one)
// `pinned` is the version the app installs, `newest` the newest release
// inside its range (PyPI). Ends with `SMOKE OK core <version>` or
// `SMOKE FAILED: <why>`, followed by the cleanups' lines.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import boot from "../dist/boot.js";
import deploy from "../dist/deploy.js";
import install from "../dist/install.js";
import lines from "../dist/lines.js";
import locate from "../dist/locate.js";
import paths from "../dist/paths.js";
import proc from "../dist/proc.js";
import release from "../dist/release.js";
import uiServer from "../dist/uiServer.js";
import versions from "../dist/versions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { values } = parseArgs({
  options: {
    core: { type: "string" },
    app: { type: "string" },
    list: { type: "boolean" },
  },
});
const win = process.platform === "win32";
const appDir =
  values.app ?? join(root, "release", win ? "win-unpacked" : "linux-unpacked");
const exe = join(appDir, win ? "EvoScientist.exe" : "evoscientist");
const resources = join(appDir, "resources");
const serverJs = join(resources, "ui", "server.js");
const range = pkg.evoscientist.coreRange;

const log = {
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.log(`  WARN ${m}`),
};
function fail(msg) {
  throw new Error(msg);
}
/** What to stop when the test ends, newest first. */
const cleanups = [];
const step = (name) => console.log(`== ${name}`);

async function coreVersion() {
  const pinned = versions.installVersion(range);
  if (!values.core || values.core === "pinned") return pinned;
  if (values.core !== "newest") return values.core;
  const r = await release.lookupNewest({ fetch, cn: false, range });
  if (!r.ok) fail(`no release inside ${range} on PyPI: ${JSON.stringify(r)}`);
  return r.version;
}

if (values.list) {
  const pinned = versions.installVersion(range);
  const r = await release.lookupNewest({ fetch, cn: false, range });
  if (!pinned || !r.ok) {
    console.error(`no versions for ${range}: ${JSON.stringify(r)}`);
    process.exit(1);
  }
  console.log(JSON.stringify([...new Set([pinned, r.version])]));
  process.exit(0);
}

async function main() {
  const version = await coreVersion();
  if (!version) fail(`the core range ${range} names no version`);
  const folders = paths.resolveFolders(process.env);
  const env = paths.folderEnv(process.env, folders);
  const uiVersion = versions.bundledUiVersion(serverJs);
  if (!uiVersion) fail(`no bundled WebUI at ${serverJs}`);
  console.log(
    `core ${version} (range ${range}), WebUI ${uiVersion}, app ${appDir}, data ${folders.dataDir}`
  );

  // As the app's launch does: the install runs in the data folder.
  mkdirSync(folders.dataDir, { recursive: true });
  step(`install the core ${version}`);
  const run = install.runInstallScript(
    install.installCommand({
      platform: process.platform,
      scriptsDir: join(resources, "core-scripts"),
      version,
      cn: false,
      env,
    }),
    { cwd: folders.dataDir, log, onLine: () => {} }
  );
  const installed = await run.done;
  if (installed.exit.code !== 0)
    fail(
      `the install script exited with ${installed.exit.code} (${
        installed.exit.signal ?? "no signal"
      })`
    );

  step("locate EvoSci");
  const found = await locate.locateEvoSci({
    dataDir: folders.dataDir,
    env,
    toolBinDir: locate.uvToolBinDir(env, folders.dataDir),
  });
  if (!found) fail("EvoSci not found after the install");
  log.info(`${found.path} (${found.via})`);
  const collect = (args, timeoutMs) =>
    proc.runCollect(found.path, args, {
      cwd: folders.dataDir,
      env,
      timeoutMs,
      log,
    });

  step("EvoSci setup --json --skip webui");
  const setup = await collect(
    ["setup", "--json", "--skip", "webui"],
    30 * 60_000
  );
  for (const l of setup.stdout) log.info(l);
  if (setup.timedOut || setup.code !== 0)
    fail(`setup ended with ${setup.timedOut ? "a timeout" : setup.code}`);

  step("EvoSci --version --json");
  const v = await collect(["--version", "--json"], 120_000);
  const info = lines.parseVersionInfo(v.stdout.join("\n"));
  if (!info) fail(`no version line: ${v.stdout.join(" | ")}`);
  log.info(JSON.stringify(info));
  if (info.version !== version)
    fail(`installed ${info.version}, asked for ${version}`);
  const problem = boot.checkCore(
    info,
    { coreRange: range, protocols: pkg.evoscientist.protocols, uiVersion },
    process.platform
  );
  if (problem) fail(`${problem.code}: ${problem.message}`);

  step("EvoSci deploy --json");
  const workspace = mkdtempSync(join(tmpdir(), "evo-smoke-"));
  const session = deploy.startDeploy(found.path, workspace, env, { log });
  cleanups.unshift(async () => log.info(`deploy: ${await session.stop()}`));
  const outcome = await Promise.race([
    session.outcome,
    new Promise((r) => setTimeout(() => r({ kind: "timeout" }), 5 * 60_000)),
  ]);
  if (outcome.kind !== "ready")
    fail(`deploy did not reach ready: ${JSON.stringify(outcome)}`);
  const ready = outcome.ready;
  log.info(`ready at ${ready.url}`);

  step("UI server under the packaged executable");
  {
    const { port } = await uiServer.pickUiPort(pkg.evoscientist.uiPort);
    const ui = uiServer.startUiServer({
      execPath: exe,
      entryScript: join(resources, "ui-entry.mjs"),
      cwd: resources,
      env: uiServer.uiServerEnv(process.env, {
        uiPort: port,
        backendUrl: ready.url,
        dataDir: ready.dataDir || folders.dataDir,
        configDir: ready.configDir || folders.configDir,
        serverJs,
      }),
      port,
      log,
    });
    cleanups.unshift(() => ui.stop());
    await ui.whenAnswering(60_000);
    const page = await fetch(ui.url);
    const html = await page.text();
    if (page.status !== 200) fail(`GET / answered ${page.status}`);
    const asset = html.match(/\/_next\/static\/[^"'\s]+\.(?:js|css)/)?.[0];
    if (!asset) fail("the page names no static asset");
    const a = await fetch(new URL(asset, ui.url));
    await a.arrayBuffer();
    if (a.status !== 200) fail(`GET ${asset} answered ${a.status}`);
    log.info(`GET / 200, GET ${asset} 200`);
  }
  return version;
}

let code = 0;
try {
  console.log(`SMOKE OK core ${await main()}`);
} catch (e) {
  console.error(`SMOKE FAILED: ${e instanceof Error ? e.message : e}`);
  code = 1;
}
for (const stop of cleanups) {
  try {
    await stop();
  } catch (e) {
    console.error(`cleanup: ${e}`);
  }
}
process.exit(code);
