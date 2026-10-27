// The launch sequence, as a state machine that tests drive without Electron:
// find `EvoSci` and check it with `--version --json` (C08); when it is missing
// or broken, install or repair it with the bundled install script (W03b);
// run `EvoSci setup` when this core version has not been set up, else the
// `node` stage; resolve the workspace folder, then `EvoSci deploy --json`
// (C13) until `ready` or an error. The window, the UI server and the screens
// live in app.ts; every dependency on the machine comes in through BootDeps.
import { join } from "node:path";
import type { DeploySession } from "./deploy";
import { failureOutput, refusedAsRunning, type InstallRun } from "./install";
import {
  parseStageEvent,
  parseVersionInfo,
  type DeployReady,
  type VersionInfo,
} from "./lines";
import { expandWorkdir, type StartConfig } from "./paths";
import type { Collected, Logger } from "./proc";
import {
  failedStages,
  parseManifest,
  setupNeeded,
  type SetupRun,
  type Stage,
} from "./setup";
import { inRange, placeInRange } from "./versions";

/** `--version --json` can be slow on a first run under Defender; a timeout is
 *  its own error with Retry, never a missing core (measurement 5 may tune it). */
export const VERSION_TIMEOUT_MS = 60_000;
/** The node stage takes about half a second with a usable Node on disk. */
export const NODE_STAGE_TIMEOUT_MS = 120_000;

/** While `update.lock` is held, how often the app looks again. */
export const UPDATE_LOCK_POLL_MS = 3_000;
/** The install script's last lines on the progress screen. */
export const INSTALL_TAIL_LINES = 12;

/** The one-line install commands from the core's install guide, for a core
 *  older than the range (until W03c updates it from the app). */
export const INSTALL_COMMANDS = {
  win32:
    "irm https://raw.githubusercontent.com/EvoScientist/EvoScientist/main/scripts/install.ps1 | iex",
  posix:
    "curl -fsSL https://raw.githubusercontent.com/EvoScientist/EvoScientist/main/scripts/install.sh | bash",
} as const;

export interface Manifest {
  /** The core releases this app supports, e.g. ">=0.3.8,<0.4". */
  coreRange: string;
  /** The `protocol` numbers of the core's JSON output that the app reads. */
  protocols: number[];
  /** The bundled WebUI's version (the app's own version). */
  uiVersion: string;
}

/** The app's own error codes, besides those of `deploy`. */
export type AppErrorCode =
  | "core_too_old"
  | "core_too_new"
  | "unknown_protocol"
  | "webui_incompatible"
  | "version_check_timeout"
  | "workspace_unavailable"
  | "ui_server_exited"
  | "install_failed"
  | "unsupported_platform"
  | "setup_failed"
  /** A quit stopped the launch; never shown. */
  | "quitting";

export interface BootError {
  code: AppErrorCode | string;
  message: string;
  detail: Record<string, unknown>;
}

export type BootState =
  | { phase: "checking_core" }
  | { phase: "asking_mirror" }
  | { phase: "update_finishing" }
  | { phase: "installing"; repair: boolean; lines: string[] }
  | { phase: "setting_up"; stages: Stage[] }
  | { phase: "preparing_node" }
  | { phase: "starting_backend"; workspace: string }
  | { phase: "ready"; ready: DeployReady }
  | { phase: "error"; error: BootError };

export type BootResult =
  | {
      ok: true;
      evosci: string;
      core: VersionInfo;
      workspace: string;
      ready: DeployReady;
      session: DeploySession;
    }
  | { ok: false; error: BootError };

export interface BootDeps {
  manifest: Manifest;
  platform: NodeJS.Platform;
  log: Logger;
  /** Where `EvoSci` and short commands run (the data folder). */
  dataDir: string;
  locate(): Promise<string | null>;
  runCollect(
    file: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<Collected>;
  startConfig(): StartConfig;
  /** `app.getPath("documents")`, which throws when it cannot resolve it. */
  documentsDir(): string;
  /** Creates the folder (recursively); throws when it cannot. */
  ensureDir(path: string): void;
  startDeploy(evosci: string, workspace: string): DeploySession;

  // Install, repair and setup (W03b)
  /** The first-launch answer about mainland China mirrors, kept in userData. */
  keptMirror(): boolean | null;
  keepMirror(cn: boolean): void;
  /** Shows the mirror question and resolves with the answer. */
  askMirror(): Promise<boolean>;
  windowsArm64(): Promise<boolean>;
  updateLockHeld(): boolean;
  pause(ms: number): Promise<void>;
  /** A quit has begun: start nothing new. */
  stopping(): boolean;
  /** Copies config.yaml before a repair; its path, or null without one. */
  backupConfig(): string | null;
  runInstall(cn: boolean, onLine: (line: string) => void): InstallRun;
  runSetup(
    evosci: string,
    cn: boolean,
    stages: Stage[],
    onUpdate: (stages: Stage[]) => void
  ): SetupRun;
  /** The core version whose setup last exited 0. */
  setupRecord(): string | null;
  recordSetup(coreVersion: string): void;
}

/** One launch's choices from the error screen. */
export interface BootOptions {
  /** "Retry with mainland China mirrors": the install script and setup get
   *  `-Cn` / `--cn` this launch, also over `mirror: default` in config.yaml.
   *  The choice is remembered: the app keeps it as the mirror answer, and
   *  `EvoSci setup --cn` saves `mirror: cn` to config.yaml. */
  cn?: boolean;
  /** "Continue" after a failed setup: start without it this time; the core
   *  version stays not set up, so the next launch runs setup again. */
  skipSetup?: boolean;
}

/**
 * Whether to use mainland China mirrors (How > Mirrors): `mirror` from
 * config.yaml first, which `EvoSci setup --cn` and the settings page write,
 * the first-launch answer only while the file has none; null when neither.
 */
export function mirrorChoice(
  config: Pick<StartConfig, "mirror">,
  kept: boolean | null
): boolean | null {
  if (config.mirror) return config.mirror === "cn";
  return kept;
}

/** The one-line install command from the core's install guide for this platform. */
const installCommand = (platform: NodeJS.Platform) =>
  platform === "win32" ? INSTALL_COMMANDS.win32 : INSTALL_COMMANDS.posix;

/** Checks the core's `--version --json` line against the app's manifest. */
export function checkCore(
  info: VersionInfo,
  manifest: Manifest,
  platform: NodeJS.Platform
): BootError | null {
  if (!manifest.protocols.includes(info.protocol)) {
    return {
      code: "unknown_protocol",
      message: `EvoScientist ${info.version} speaks protocol ${info.protocol}, which this app does not know.`,
      detail: {
        version: info.version,
        protocol: info.protocol,
        known: manifest.protocols,
      },
    };
  }
  const placement = placeInRange(info.version, manifest.coreRange);
  if (placement === "above") {
    return {
      code: "core_too_new",
      message: `EvoScientist ${info.version} is newer than this app supports (${manifest.coreRange}). Update the app.`,
      detail: { version: info.version, range: manifest.coreRange },
    };
  }
  if (placement !== "inside") {
    // Below the range, or not a release number (a pre-release or a local
    // version never matches): until W03c, reinstall with the install command.
    return {
      code: "core_too_old",
      message:
        placement === "below"
          ? `EvoScientist ${info.version} is older than this app supports (${manifest.coreRange}).`
          : `EvoScientist ${info.version} is not a release this app supports (${manifest.coreRange}).`,
      detail: {
        version: info.version,
        range: manifest.coreRange,
        not_a_release: placement === "invalid",
        install_command: installCommand(platform),
      },
    };
  }
  if (!inRange(manifest.uiVersion, info.webuiCompat)) {
    return {
      code: "webui_incompatible",
      message: `EvoScientist ${info.version} does not accept this app's WebUI ${manifest.uiVersion} (${info.webuiCompat}). Update the app.`,
      detail: {
        version: info.version,
        webui_compat: info.webuiCompat,
        ui_version: manifest.uiVersion,
      },
    };
  }
  return null;
}

/** The workspace folder: `default_workdir` when set, else Documents/EvoScientist. */
export function resolveWorkspace(
  config: StartConfig,
  deps: Pick<BootDeps, "documentsDir" | "ensureDir">
): { ok: true; folder: string } | { ok: false; error: BootError } {
  let folder: string;
  const source = config.defaultWorkdir ? "default_workdir" : "documents";
  try {
    folder = config.defaultWorkdir
      ? expandWorkdir(config.defaultWorkdir)
      : join(deps.documentsDir(), "EvoScientist");
    deps.ensureDir(folder);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "workspace_unavailable",
        message:
          source === "default_workdir"
            ? `The folder set as default_workdir cannot be created: ${config.defaultWorkdir}`
            : "The Documents folder cannot be resolved, or its EvoScientist folder cannot be created.",
        detail: { source, folder: config.defaultWorkdir, error: String(e) },
      },
    };
  }
  return { ok: true, folder };
}

type VersionCheck =
  | { kind: "ok"; info: VersionInfo }
  | { kind: "timeout" }
  | { kind: "broken"; why: string };

/** `EvoSci --version --json`: a version, a timeout, or a core that does not run. */
async function checkVersion(
  deps: BootDeps,
  evosci: string
): Promise<VersionCheck> {
  const v = await deps.runCollect(
    evosci,
    ["--version", "--json"],
    deps.dataDir,
    VERSION_TIMEOUT_MS
  );
  if (v.timedOut) return { kind: "timeout" };
  const info = v.code === 0 ? parseVersionInfo(v.stdout.join("\n")) : null;
  return info
    ? { kind: "ok", info }
    : {
        kind: "broken",
        why: `EvoSci --version --json exited ${v.code} without a version line`,
      };
}

const versionTimeout = (evosci: string): BootError => ({
  code: "version_check_timeout",
  message: `EvoSci --version --json did not answer within ${
    VERSION_TIMEOUT_MS / 1000
  } s.`,
  detail: { evosci },
});

const QUITTING: BootError = {
  code: "quitting",
  message: "The app is quitting.",
  detail: {},
};

/**
 * Installs the core (none found) or repairs it (found, but it does not run)
 * with the bundled install script, after the mirror question (a fresh install
 * only), the arm64 check and the wait for an update that is still finishing.
 * A repair copies config.yaml first. The mirror choice it installed with
 * and the script's lines when it exited 0, else the error.
 */
async function installCore(
  deps: BootDeps,
  onState: (s: BootState) => void,
  repair: boolean,
  options: BootOptions
): Promise<{ cn: boolean; lines: string[] } | BootError> {
  // Before the question: on Windows on Arm the answer would change nothing.
  if (deps.platform === "win32" && (await deps.windowsArm64()))
    return {
      code: "unsupported_platform",
      message:
        "EvoScientist cannot be installed on Windows on Arm yet: the install script supports x64 Windows only.",
      detail: { arch: "ARM64" },
    };
  let cn = options.cn
    ? true
    : mirrorChoice(deps.startConfig(), deps.keptMirror());
  if (cn === null) {
    if (repair) cn = false;
    else {
      onState({ phase: "asking_mirror" });
      cn = await deps.askMirror();
      deps.keepMirror(cn);
      deps.log.info(`mirror question: ${cn ? "cn" : "default"}`);
    }
  }
  if (deps.stopping()) return QUITTING;
  while (deps.updateLockHeld()) {
    onState({ phase: "update_finishing" });
    await deps.pause(UPDATE_LOCK_POLL_MS);
    if (deps.stopping()) return QUITTING;
  }
  if (repair) {
    try {
      const copy = deps.backupConfig();
      deps.log.info(
        copy ? `config.yaml copied to ${copy}` : "no config.yaml to copy"
      );
    } catch (e) {
      return {
        code: "install_failed",
        message: `config.yaml could not be copied before the repair: ${e}`,
        detail: { repair, cn, output: [] },
      };
    }
  }
  deps.log.info(
    `${repair ? "repairing" : "installing"} the core${
      cn ? " with mainland China mirrors" : ""
    }`
  );
  const shown: string[] = [];
  onState({ phase: "installing", repair, lines: [] });
  const run = deps.runInstall(cn, (line) => {
    shown.push(line);
    if (shown.length > INSTALL_TAIL_LINES) shown.shift();
    onState({ phase: "installing", repair, lines: [...shown] });
  });
  const { exit, lines } = await run.done;
  if (deps.stopping()) return QUITTING;
  if (exit.code === 0) return { cn, lines };
  const output = failureOutput(lines);
  return {
    code: "install_failed",
    message: repair
      ? "EvoScientist could not be repaired."
      : "EvoScientist could not be installed.",
    detail: {
      repair,
      cn,
      exit_code: exit.code,
      output,
      running: refusedAsRunning(output),
    },
  };
}

/** `EvoSci setup --json --skip webui` with its stage list; null after exit 0,
 *  which records the core version as set up. Mirrors: "Retry with mainland
 *  China mirrors" first, then config.yaml or the kept answer, else as the
 *  install of this launch used them. */
async function setUp(
  deps: BootDeps,
  onState: (s: BootState) => void,
  evosci: string,
  info: VersionInfo,
  options: BootOptions,
  installedCn: boolean | null
): Promise<BootError | null> {
  onState({ phase: "setting_up", stages: [] });
  const m = await deps.runCollect(
    evosci,
    ["setup", "--manifest"],
    deps.dataDir,
    VERSION_TIMEOUT_MS
  );
  const stages = parseManifest(m.stdout);
  if (!stages)
    deps.log.warn(`setup --manifest gave no stage list (exit ${m.code})`);
  const cn =
    options.cn ||
    (mirrorChoice(deps.startConfig(), deps.keptMirror()) ??
      installedCn ??
      false);
  // Closing during `--manifest` does not ask (no step runs yet): nothing new
  // starts once a quit began.
  if (deps.stopping()) return QUITTING;
  onState({ phase: "setting_up", stages: stages ?? [] });
  const run = deps.runSetup(evosci, cn, stages ?? [], (s) =>
    onState({ phase: "setting_up", stages: s })
  );
  const { exit, stages: end } = await run.done;
  if (deps.stopping()) return QUITTING;
  if (exit.code === 0) {
    deps.recordSetup(info.version);
    return null;
  }
  const failed = failedStages(end);
  return {
    code: "setup_failed",
    message:
      failed.length > 0
        ? `${
            failed.length === 1
              ? "One setup step"
              : `${failed.length} setup steps`
          } failed.`
        : `EvoSci setup exited ${exit.code}.`,
    detail: {
      cn,
      exit_code: exit.code,
      failed: failed.map((f) => ({
        id: f.id,
        title: f.title,
        code: f.code ?? null,
        message: f.message ?? null,
      })),
    },
  };
}

/** The launch sequence up to `ready`: find and check the core (installing
 *  or repairing it when needed), set it up or run the node stage, resolve the
 *  workspace and start `deploy`. Reports each phase through `onState`. */
export async function boot(
  deps: BootDeps,
  onState: (s: BootState) => void,
  options: BootOptions = {}
): Promise<BootResult> {
  const fail = (error: BootError): BootResult => {
    deps.log.warn(`boot error ${error.code}: ${error.message}`);
    onState({ phase: "error", error });
    return { ok: false, error };
  };

  onState({ phase: "checking_core" });
  let evosci = await deps.locate();
  let check: VersionCheck | null = null;
  if (evosci) {
    deps.log.info(`EvoSci: ${evosci}`);
    check = await checkVersion(deps, evosci);
    if (check.kind === "timeout") return fail(versionTimeout(evosci));
    if (check.kind === "broken")
      deps.log.warn(`${check.why}: repairing the core`);
  } else {
    deps.log.info("EvoSci was not found: installing the core");
  }

  let installedCn: boolean | null = null;
  let freshInstall = false;
  if (!evosci || check?.kind !== "ok") {
    const repair = Boolean(evosci);
    const installed = await installCore(deps, onState, repair, options);
    if ("code" in installed) return fail(installed);
    installedCn = installed.cn;
    freshInstall = !repair;
    // The script exited 0, so its last lines, not an `Error:` line.
    const after = {
      repair,
      cn: installed.cn,
      output: failureOutput(installed.lines),
    };
    onState({ phase: "checking_core" });
    evosci = await deps.locate();
    if (!evosci)
      return fail({
        code: "install_failed",
        message: "The install script finished, but EvoSci was not found.",
        detail: after,
      });
    deps.log.info(`EvoSci after the install: ${evosci}`);
    check = await checkVersion(deps, evosci);
    if (check.kind === "timeout") return fail(versionTimeout(evosci));
    if (check.kind === "broken")
      return fail({
        code: "install_failed",
        message: `EvoScientist still does not run after the install (${check.why}).`,
        detail: { ...after, evosci },
      });
  }
  const info = check.info;
  deps.log.info(
    `core ${info.version}, protocol ${info.protocol}, webui_compat ${info.webuiCompat}`
  );
  const incompatible = checkCore(info, deps.manifest, deps.platform);
  if (incompatible) return fail(incompatible);

  // Setup after a fresh install (whatever the record says: the core's data
  // folder may be new), on the first launch and after the core version
  // changed; it covers the node stage. "Continue" after a failed setup skips
  // it this time.
  let setUpNow = false;
  if (
    !options.skipSetup &&
    (freshInstall || setupNeeded(deps.setupRecord(), info.version))
  ) {
    const error = await setUp(
      deps,
      onState,
      evosci,
      info,
      options,
      installedCn
    );
    if (error) return fail(error);
    setUpNow = true;
  }
  if (deps.stopping()) return fail(QUITTING);

  // A terminal `EvoSci setup` with a system Node drops the private Node's
  // record; without this stage the agent's shell would have no npx. Errors
  // are logged and the launch goes on.
  if (!setUpNow) {
    onState({ phase: "preparing_node" });
    const n = await deps.runCollect(
      evosci,
      ["setup", "--stage", "node", "--json"],
      deps.dataDir,
      NODE_STAGE_TIMEOUT_MS
    );
    const nodeEnd = n.stdout
      .map(parseStageEvent)
      .filter((e) => e?.stage === "node" && e.status !== "running")
      .pop();
    if (n.timedOut || n.code !== 0 || nodeEnd?.status === "error") {
      deps.log.warn(
        `node stage: ${n.timedOut ? "timed out" : `exit ${n.code}`}${
          nodeEnd?.code ? `, code ${nodeEnd.code}` : ""
        }; continuing`
      );
    }
  }

  const ws = resolveWorkspace(deps.startConfig(), deps);
  if (!ws.ok) return fail(ws.error);

  onState({ phase: "starting_backend", workspace: ws.folder });
  const session = deps.startDeploy(evosci, ws.folder);
  // No limit here: the core's own start timeout (`wait_ready`, 60 s) ends
  // `deploy` with an error, and its exit settles the outcome.
  const outcome = await session.outcome;
  if (outcome.kind === "error") {
    return fail({
      code: outcome.error.code,
      message: outcome.error.message,
      detail: outcome.error.detail,
    });
  }
  for (const w of outcome.ready.warnings) deps.log.warn(`deploy warning: ${w}`);
  onState({ phase: "ready", ready: outcome.ready });
  return {
    ok: true,
    evosci,
    core: info,
    workspace: ws.folder,
    ready: outcome.ready,
    session,
  };
}
