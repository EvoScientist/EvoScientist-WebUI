// The launch sequence, as a state machine that tests drive without Electron:
// find `EvoSci` and check it with `--version --json` (C08); when it is missing
// or broken, install or repair it with the bundled install script (W03b);
// when it is older than the app's range, offer to update it (W03c): with
// `EvoSci update` (C11) from 0.3.7 on, else, and for a pip or conda install,
// with the bundled script;
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
import type { Lookup } from "./release";
import {
  failedStages,
  parseManifest,
  setupNeeded,
  type SetupRun,
  type Stage,
} from "./setup";
import type { UpdateRun, UpdateView } from "./update";
import {
  compareReleases,
  inRange,
  parseRelease,
  placeInRange,
} from "./versions";

/** `--version --json` can be slow on a first run under Defender; a timeout is
 *  its own error with Retry, never a missing core (measurement 5 may tune it). */
export const VERSION_TIMEOUT_MS = 60_000;
/** The node stage takes about half a second with a usable Node on disk. */
export const NODE_STAGE_TIMEOUT_MS = 120_000;

/** While `update.lock` is held, how often the app looks again. */
export const UPDATE_LOCK_POLL_MS = 3_000;
/** The install script's last lines on the progress screen. */
export const INSTALL_TAIL_LINES = 12;

/** The first core release with `EvoSci update` (C11 merged after 0.3.6);
 *  an older core is updated with the bundled install script. */
export const FIRST_UPDATABLE = "0.3.7";

/** The one-line install commands from the core's install guide, for a core
 *  whose version is not a release, or still outside the range after an
 *  update. */
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
  | "release_lookup_failed"
  /** `EvoSci update` ended without its terminal line, or the core does not
   *  run after it. */
  | "update_failed"
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
  | { phase: "asking_update" }
  | { phase: "update_finishing" }
  | { phase: "looking_up_release" }
  | { phase: "updating"; view: UpdateView }
  /** `update`: the install script brings an older core to the app's version. */
  | { phase: "installing"; repair: boolean; update?: boolean; lines: string[] }
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
      /** Shown once the app is ready (a pip or conda copy left as it was). */
      notice?: string;
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
  /** Records a setup that exited 0; null forgets the record. */
  recordSetup(coreVersion: string | null): void;

  // Core updates (W03c)
  /** Shows the update offer; resolves when the user chooses Update (Quit
   *  quits the app). */
  askUpdate(from: string): Promise<void>;
  /** After `manual_update` without a uv tool install: offers a separate
   *  copy; resolves when the user chooses to install it. */
  askSeparateInstall(message: string, from: string): Promise<void>;
  /** The busy check, then a stop of the backend the app started, if one
   *  runs; false when the user keeps it running. */
  stopOwnBackend(): Promise<boolean>;
  /** The newest release inside the range on the update's index. */
  lookupRelease(cn: boolean): Promise<Lookup>;
  runUpdate(
    evosci: string,
    version: string,
    stages: Stage[],
    onUpdate: (view: UpdateView) => void
  ): UpdateRun;
  /** Whether a backend answers `/ok` with 200 on this loopback port. */
  backendAnswers(port: number): Promise<boolean>;
  /** Whether uv's tool directory holds an EvoScientist environment; null
   *  when uv does not answer. */
  uvToolEnvExists(): Promise<boolean | null>;
}

/** One launch's choices from the error screen. */
export interface BootOptions {
  /** "Retry with mainland China mirrors": the install script and setup get
   *  `-Cn` / `--cn` this launch, also over `mirror: default` in config.yaml.
   *  The choice is remembered: the app keeps it as the mirror answer, and
   *  `EvoSci setup --cn` saves `mirror: cn` to config.yaml. */
  cn?: boolean;
  /** "Continue" after a failed setup: start without it for the rest of this
   *  session, unless the core is installed again; the core version stays
   *  not set up, so the next launch runs setup again. */
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
    // version never matches): `boot` offers the update for a release below
    // the range; the rest keep the install command.
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
 * with the bundled install script, after the arm64 check and the mirror
 * question (a fresh install only). A repair copies config.yaml first. The
 * mirror choice it installed with and the script's lines when it exited 0,
 * "update" when an update took its lock meanwhile, else the error.
 */
async function installCore(
  deps: BootDeps,
  onState: (s: BootState) => void,
  repair: boolean,
  options: BootOptions,
  update = false
): Promise<{ cn: boolean; lines: string[] } | BootError | "update"> {
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
  if (deps.updateLockHeld()) return "update";
  // An older record for this version would make a setup that fails or is
  // stopped after this install count as done; a repair keeps it.
  if (!repair && deps.setupRecord() !== null) deps.recordSetup(null);
  if (repair) {
    try {
      const copy = deps.backupConfig();
      deps.log.info(
        copy ? `config.yaml copied to ${copy}` : "no config.yaml to copy"
      );
    } catch (e) {
      return {
        code: "install_failed",
        message: `config.yaml could not be copied before the ${
          update ? "update" : "repair"
        }: ${e}`,
        detail: { repair, update, cn, output: [] },
      };
    }
  }
  deps.log.info(
    `${update ? "updating" : repair ? "repairing" : "installing"} the core${
      cn ? " with mainland China mirrors" : ""
    }`
  );
  const shown: string[] = [];
  onState({ phase: "installing", repair, update, lines: [] });
  const run = deps.runInstall(cn, (line) => {
    shown.push(line);
    if (shown.length > INSTALL_TAIL_LINES) shown.shift();
    onState({ phase: "installing", repair, update, lines: [...shown] });
  });
  const { exit, lines } = await run.done;
  if (deps.stopping()) return QUITTING;
  if (exit.code === 0) return { cn, lines };
  const output = failureOutput(lines);
  return {
    code: "install_failed",
    message: update
      ? "EvoScientist could not be updated."
      : repair
      ? "EvoScientist could not be repaired."
      : "EvoScientist could not be installed.",
    detail: {
      repair,
      update,
      cn,
      exit_code: exit.code,
      output,
      running: refusedAsRunning(output),
    },
  };
}

/** Waits while `EvoSci update` holds `tools/update.lock`: its helper replaces
 *  the environment meanwhile, so the core looks missing or broken. False
 *  when a quit began. */
async function waitForUpdate(
  deps: BootDeps,
  onState: (s: BootState) => void
): Promise<boolean> {
  if (!deps.updateLockHeld()) return true;
  deps.log.info("update_in_progress: an update holds tools/update.lock");
  do {
    onState({ phase: "update_finishing" });
    await deps.pause(UPDATE_LOCK_POLL_MS);
    if (deps.stopping()) return false;
  } while (deps.updateLockHeld());
  return true;
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

/**
 * The install script (installCore), then the core it installed: located and
 * checked with `--version --json`. Errors keep the script's last lines.
 */
async function installAndCheck(
  deps: BootDeps,
  onState: (s: BootState) => void,
  repair: boolean,
  options: BootOptions,
  update = false
): Promise<
  { evosci: string; info: VersionInfo; cn: boolean } | BootError | "update"
> {
  const installed = await installCore(deps, onState, repair, options, update);
  if (installed === "update" || "code" in installed) return installed;
  // The script exited 0, so its last lines, not an `Error:` line.
  const after = {
    repair,
    update,
    cn: installed.cn,
    output: failureOutput(installed.lines),
  };
  onState({ phase: "checking_core" });
  const evosci = await deps.locate();
  if (!evosci)
    return {
      code: "install_failed",
      message: "The install script finished, but EvoSci was not found.",
      detail: after,
    };
  deps.log.info(`EvoSci after the install: ${evosci}`);
  const check = await checkVersion(deps, evosci);
  if (check.kind === "timeout") return versionTimeout(evosci);
  if (check.kind === "broken")
    return {
      code: "install_failed",
      message: `EvoScientist still does not run after the install (${check.why}).`,
      detail: { ...after, evosci },
    };
  return { evosci, info: check.info, cn: installed.cn };
}

/** "Stop the backend started in the terminal, then retry": a backend the
 *  app did not start answers on the port. */
const terminalBackend = (port: number, coreMessage?: string): BootError => ({
  code: "server_running",
  message: "A backend started in a terminal is running.",
  detail: { port, ...(coreMessage ? { core_message: coreMessage } : {}) },
});

/** How updateCore ended: updated in place (its setup recorded when the
 *  version is inside the range), or the bundled script is to run. */
type Updated =
  | { kind: "updated"; info: VersionInfo }
  | { kind: "script"; notice?: string };

/**
 * A core older than the range (W03c): the offer, the busy check and stop of
 * the app's own backend, then `EvoSci update` to the newest release in the
 * range (from 0.3.7 on) with a new version check, or, for 0.3.6 and for a
 * pip or conda install (`manual_update` without a uv tool install), the
 * bundled script. The update runs the new version's setup itself: after
 * `done` that version counts as set up, so setup does not run twice.
 */
async function updateCore(
  deps: BootDeps,
  onState: (s: BootState) => void,
  evosci: string,
  info: VersionInfo,
  options: BootOptions
): Promise<Updated | BootError | "update"> {
  for (;;) {
    onState({ phase: "asking_update" });
    await deps.askUpdate(info.version);
    if (deps.stopping()) return QUITTING;
    if (await deps.stopOwnBackend()) break;
    deps.log.info("update: the backend keeps running; asking again");
  }
  // Below the range, so a release number.
  const release = parseRelease(info.version) ?? [];
  if (compareReleases(release, parseRelease(FIRST_UPDATABLE) ?? []) < 0) {
    const port = deps.startConfig().port;
    if (await deps.backendAnswers(port)) return terminalBackend(port);
    deps.log.info(
      `core ${info.version} has no EvoSci update: the bundled script installs this app's version`
    );
    return { kind: "script" };
  }

  onState({ phase: "looking_up_release" });
  const cn = deps.startConfig().mirror === "cn";
  const found = await deps.lookupRelease(cn);
  if (!found.ok) {
    if (found.listed)
      deps.log.info(`listed on ${found.url}: ${found.listed.join(", ")}`);
    return {
      code: "release_lookup_failed",
      message: `The newest EvoScientist release could not be found on ${found.url} (${found.reason}).`,
      detail: {
        url: found.url,
        reason: found.reason,
        answered: found.answered,
        cn,
      },
    };
  }
  if (deps.stopping()) return QUITTING;
  // A terminal update took its lock meanwhile: wait for it and start over.
  if (deps.updateLockHeld()) return "update";

  // The installed core's stages: the update forwards the new version's
  // setup lines, which fill them in.
  const m = await deps.runCollect(
    evosci,
    ["setup", "--manifest"],
    deps.dataDir,
    VERSION_TIMEOUT_MS
  );
  const stages = parseManifest(m.stdout) ?? [];
  if (deps.stopping()) return QUITTING;
  deps.log.info(`updating the core ${info.version} -> ${found.version}`);
  onState({
    phase: "updating",
    view: { update: {}, stages, waiting: null },
  });
  const run = deps.runUpdate(evosci, found.version, stages, (view) =>
    onState({ phase: "updating", view })
  );
  const { outcome, view } = await run.done;
  // Closing waits for the update (D21); after it nothing new starts.
  if (deps.stopping()) return QUITTING;

  if (outcome.kind === "no_terminal_line")
    return {
      code: "update_failed",
      message: `EvoSci update ended without its result (exit ${outcome.exit.code}).`,
      detail: { version: found.version, exit_code: outcome.exit.code },
    };
  if (outcome.kind === "done") {
    onState({ phase: "checking_core" });
    const check = await checkVersion(deps, evosci);
    if (check.kind === "timeout") return versionTimeout(evosci);
    if (check.kind === "broken")
      return {
        code: "update_failed",
        message: `EvoScientist does not run after the update (${check.why}).`,
        detail: { version: found.version },
      };
    if (!checkCore(check.info, deps.manifest, deps.platform))
      deps.recordSetup(check.info.version);
    return { kind: "updated", info: check.info };
  }

  // `source`: the update's own failure, which the mirror retry cannot help
  // (the update reads `mirror` from config.yaml only).
  const detail = { ...outcome.detail, update: true, source: "update" };
  switch (outcome.code) {
    case "manual_update": {
      const env = await deps.uvToolEnvExists();
      deps.log.info(`manual_update; uv tool install of EvoScientist: ${env}`);
      // A uv tool install from a checkout or a URL: the script would put
      // the PyPI release over it.
      if (env !== false)
        return { code: "manual_update", message: outcome.message, detail };
      onState({ phase: "asking_update" });
      await deps.askSeparateInstall(outcome.message, info.version);
      if (deps.stopping()) return QUITTING;
      return {
        kind: "script",
        notice: `The EvoSci of your pip or conda install is still ${info.version}. A terminal may still run it: upgrade it, or use only the desktop app.`,
      };
    }
    case "server_running":
      return terminalBackend(deps.startConfig().port, outcome.message);
    case "setup_failed": {
      // The core is updated, its setup is not: Retry runs setup again.
      const failed = failedStages(view.stages);
      return {
        code: "setup_failed",
        message:
          failed.length > 0
            ? `${
                failed.length === 1
                  ? "One setup step"
                  : `${failed.length} setup steps`
              } failed after the update.`
            : "EvoScientist was updated, but its setup failed.",
        detail: {
          update: true,
          cn:
            options.cn ||
            (mirrorChoice(deps.startConfig(), deps.keptMirror()) ?? false),
          failed: failed.map((f) => ({
            id: f.id,
            title: f.title,
            code: f.code ?? null,
            message: f.message ?? null,
          })),
        },
      };
    }
    default:
      return { code: outcome.code, message: outcome.message, detail };
  }
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

  if (!(await waitForUpdate(deps, onState))) return fail(QUITTING);
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
  let notice: string | undefined;
  if (!evosci || check?.kind !== "ok") {
    const repair = Boolean(evosci);
    const installed = await installAndCheck(deps, onState, repair, options);
    // An update took its lock: wait for it and check the core again; the
    // mirror answer is kept, so nothing is asked twice.
    if (installed === "update") return boot(deps, onState, options);
    if ("code" in installed) return fail(installed);
    ({ evosci, cn: installedCn } = installed);
    check = { kind: "ok", info: installed.info };
    freshInstall = !repair;
  }
  let info = check.info;
  deps.log.info(
    `core ${info.version}, protocol ${info.protocol}, webui_compat ${info.webuiCompat}`
  );
  let incompatible = checkCore(info, deps.manifest, deps.platform);
  // Older than the range: the update offer (W03c). A version that is not a
  // release cannot be placed, and updating `0.4.0a1` would be a downgrade.
  if (
    incompatible?.code === "core_too_old" &&
    !incompatible.detail.not_a_release
  ) {
    const updated = await updateCore(deps, onState, evosci, info, options);
    if (updated === "update") return boot(deps, onState, options);
    if ("code" in updated) return fail(updated);
    if (updated.kind === "script") {
      const installed = await installAndCheck(
        deps,
        onState,
        true,
        options,
        true
      );
      if (installed === "update") return boot(deps, onState, options);
      if ("code" in installed) return fail(installed);
      ({ evosci, cn: installedCn, info } = installed);
      notice = updated.notice;
    } else info = updated.info;
    incompatible = checkCore(info, deps.manifest, deps.platform);
  }
  if (incompatible) return fail(incompatible);

  // Setup after a fresh install (the script ran with -NoSetup, and the
  // core's data folder may be new), on the first launch and after the core
  // version changed; it covers the node stage. "Continue" after a failed
  // setup skips it for the rest of the session, except after a fresh install.
  let setUpNow = false;
  if (
    freshInstall ||
    (!options.skipSetup && setupNeeded(deps.setupRecord(), info.version))
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
    ...(notice ? { notice } : {}),
  };
}
