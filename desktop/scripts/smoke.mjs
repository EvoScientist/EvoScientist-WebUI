// The desktop smoke test (.github/workflows/desktop.yml), on an unpacked
// build (`npm run pack`), through the app's own code (dist/):
// 1. install the core with the bundled install script (`-Version <v> -NoSetup`,
//    `--version <v> --no-setup` on macOS and Linux);
// 2. `EvoSci setup --json --skip webui`;
// 3. `EvoSci --version --json`: the version asked for, inside the app's core
//    range, and its `webui_compat` accepts the bundled WebUI;
// 4. `EvoSci deploy --json` until `ready`;
// 5. the bundled UI server under the packaged executable (on macOS the app's
//    helper) with ELECTRON_RUN_AS_NODE=1: `/` and one static asset answer
//    200, on macOS it has no Dock icon of its own (after a control
//    process showed that a Dock icon would be seen), and it wrote nothing
//    into the app's folder.
// Usage: node scripts/smoke.mjs --core pinned|newest|<version> [--app <dir>]
//                                [--use-my-folders]
//        (<dir>: the unpacked app's folder; on macOS the .app bundle)
//        node scripts/smoke.mjs --ui-only [--app <dir>]   (step 5 alone, with
//        a backend address nothing listens on and scratch folders: for a
//        build that step 1 to 4 already ran on in another form, as the signed
//        macOS app of a release. It installs nothing, so it needs no
//        --use-my-folders.)
//        node scripts/smoke.mjs --list   (the versions to test, as JSON: one
//        when the newest release inside the range is the pinned one)
// The test installs the core and runs setup in this user's own folders, as
// the app does (and the install script adds to the user's PATH on Windows,
// to the shell profile on macOS and Linux),
// so outside CI it runs only with --use-my-folders: on a CI runner, a
// throwaway account, or with HOME / USERPROFILE / APPDATA / LOCALAPPDATA
// pointed at a scratch folder.
// `pinned` is the version the app installs, `newest` the newest release
// inside its range (PyPI). Ends with `SMOKE OK core <version>` (`SMOKE OK ui
// only`) or `SMOKE FAILED: <why>`, followed by the cleanups' lines.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import boot from "../dist/boot.js";
import deploy from "../dist/deploy.js";
import install from "../dist/install.js";
import lines from "../dist/lines.js";
import locate from "../dist/locate.js";
import packaging from "../dist/packaging.js";
import paths from "../dist/paths.js";
import proc from "../dist/proc.js";
import release from "../dist/release.js";
import uiServer from "../dist/uiServer.js";
import versions from "../dist/versions.js";
import { dockIconOf } from "./dock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { values } = parseArgs({
  options: {
    core: { type: "string" },
    app: { type: "string" },
    list: { type: "boolean" },
    "use-my-folders": { type: "boolean" },
    "ui-only": { type: "boolean" },
  },
});
const { appDir, exe, resources } = packaging.appLayout(
  process.platform,
  join(root, "release"),
  values.app
);
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
  if (!process.env.CI && !values["use-my-folders"])
    fail(
      "this installs a core and runs setup in this user's folders; outside CI pass --use-my-folders (see the header)"
    );
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

  await checkUiServer({
    backendUrl: ready.url,
    dataDir: ready.dataDir || folders.dataDir,
    configDir: ready.configDir || folders.configDir,
  });
  return `core ${version}`;
}

/** Step 5: the bundled UI server under the packaged executable. */
async function checkUiServer({ backendUrl, dataDir, configDir }) {
  step("UI server under the packaged executable");
  {
    const startedAt = Date.now();
    const { port } = await uiServer.pickUiPort(pkg.evoscientist.uiPort);
    const ui = uiServer.startUiServer({
      execPath: uiServer.uiServerExec(exe, process.platform, existsSync),
      entryScript: join(resources, "ui-entry.mjs"),
      cwd: resources,
      env: uiServer.uiServerEnv(process.env, {
        uiPort: port,
        backendUrl,
        dataDir,
        configDir,
        serverJs,
      }),
      port,
      log,
    });
    let stopped = false;
    const stopUi = async () => {
      if (stopped) return;
      stopped = true;
      await ui.stop();
    };
    cleanups.unshift(stopUi);
    let uiEnded = false;
    void ui.exited.then(() => (uiEnded = true));
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
    // Two more kinds of request that made the server write a page to its
    // cache: a file route and a page that is not there.
    for (const path of ["/icon.png", "/no-such-page-for-the-smoke-test"])
      await (await fetch(new URL(path, ui.url))).arrayBuffer();
    if (process.platform === "darwin") {
      // The server has set its process title by now (Next does before it
      // listens), which is what registers it with macOS, so it is in the
      // application list. It is looked up in a list that shows a control
      // process with a Dock icon: where the control or the server itself is
      // not listed, the check would see nothing and must not pass.
      const dock = await dockIconOf(ui.pid, exe);
      // A server that ended meanwhile is in no list: say that, where known.
      // One turn of the event loop first: the check's last read blocks, so
      // an exit during it has not been reported yet.
      await new Promise((r) => setImmediate(r));
      if (uiEnded) fail("the UI server ended during the checks");
      if ("unseen" in dock) fail(`the Dock check sees nothing: ${dock.unseen}`);
      if (dock.shown) fail("the UI server has a Dock icon of its own");
      log.info("Dock: no icon for the UI server (a control process has one)");
    }
    if (uiEnded) fail("the UI server ended during the checks");
    // The server leaves the app's folder as it was, also while it stops. On
    // macOS that folder is the signed bundle: one file added there breaks
    // the signature, and the system reports an app that was used once as
    // modified.
    await stopUi();
    const written = packaging.changedSince(appDir, startedAt);
    if (written.length)
      fail(
        `the UI server wrote into the app's folder: ${written
          .slice(0, 4)
          .join(", ")}${
          written.length > 4 ? ` and ${written.length - 4} more` : ""
        }`
      );
    log.info("the UI server wrote nothing into the app's folder");
  }
}

/** `--ui-only`: the page and its assets are served without a backend. */
async function uiOnly() {
  if (!versions.bundledUiVersion(serverJs))
    fail(`no bundled WebUI at ${serverJs}`);
  console.log(`UI server only, app ${appDir}`);
  const scratch = mkdtempSync(join(tmpdir(), "evo-smoke-ui-"));
  cleanups.unshift(() => rmSync(scratch, { recursive: true, force: true }));
  await checkUiServer({
    // The discard port: nothing answers there.
    backendUrl: "http://127.0.0.1:9",
    dataDir: join(scratch, "data"),
    // Named evoscientist: only then does the UI server look for config.yaml
    // here (uiServerEnv sets XDG_CONFIG_HOME to its parent), not in the
    // user's own config folder.
    configDir: join(scratch, "config", "evoscientist"),
  });
  return "ui only";
}

let code = 0;
try {
  console.log(`SMOKE OK ${await (values["ui-only"] ? uiOnly() : main())}`);
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
