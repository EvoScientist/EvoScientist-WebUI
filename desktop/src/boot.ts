// The launch sequence on an installed core (W03a), as a state machine that
// tests drive without Electron: find `EvoSci`, check it with
// `--version --json` (C08), run the `node` stage, resolve the workspace
// folder, then `EvoSci deploy --json` (C13) until `ready` or an error. The
// window, the UI server and the screens live in main.ts; every dependency on
// the machine comes in through BootDeps.
import { join } from "node:path";
import type { DeploySession } from "./deploy";
import {
  parseStageEvent,
  parseVersionInfo,
  type DeployReady,
  type VersionInfo,
} from "./lines";
import { expandWorkdir, type StartConfig } from "./paths";
import type { Collected, Logger } from "./proc";
import { inRange, placeInRange } from "./versions";

/** `--version --json` can be slow on a first run under Defender; a timeout is
 *  its own error with Retry, never a missing core (measurement 5 may tune it). */
export const VERSION_TIMEOUT_MS = 60_000;
/** The node stage takes about half a second with a usable Node on disk. */
export const NODE_STAGE_TIMEOUT_MS = 120_000;

/** The one-line install commands from the core's install guide (until W03b
 *  installs the core itself). */
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
  | "core_missing"
  | "core_too_old"
  | "core_too_new"
  | "unknown_protocol"
  | "webui_incompatible"
  | "version_check_timeout"
  | "workspace_unavailable"
  | "ui_server_exited";

export interface BootError {
  code: AppErrorCode | string;
  message: string;
  detail: Record<string, unknown>;
}

export type BootState =
  | { phase: "checking_core" }
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
}

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

export async function boot(
  deps: BootDeps,
  onState: (s: BootState) => void
): Promise<BootResult> {
  const fail = (error: BootError): BootResult => {
    deps.log.warn(`boot error ${error.code}: ${error.message}`);
    onState({ phase: "error", error });
    return { ok: false, error };
  };

  onState({ phase: "checking_core" });
  const evosci = await deps.locate();
  const missing = (why: string): BootError => ({
    code: "core_missing",
    message: `EvoScientist is not installed, or does not run (${why}).`,
    detail: { install_command: installCommand(deps.platform), evosci },
  });
  if (!evosci) return fail(missing("EvoSci was not found"));
  deps.log.info(`EvoSci: ${evosci}`);

  const v = await deps.runCollect(
    evosci,
    ["--version", "--json"],
    deps.dataDir,
    VERSION_TIMEOUT_MS
  );
  if (v.timedOut) {
    return fail({
      code: "version_check_timeout",
      message: `EvoSci --version --json did not answer within ${
        VERSION_TIMEOUT_MS / 1000
      } s.`,
      detail: { evosci },
    });
  }
  const info = v.code === 0 ? parseVersionInfo(v.stdout.join("\n")) : null;
  if (!info)
    return fail(
      missing(`EvoSci --version --json exited ${v.code} without a version line`)
    );
  deps.log.info(
    `core ${info.version}, protocol ${info.protocol}, webui_compat ${info.webuiCompat}`
  );
  const incompatible = checkCore(info, deps.manifest, deps.platform);
  if (incompatible) return fail(incompatible);

  // A terminal `EvoSci setup` with a system Node drops the private Node's
  // record; without this stage the agent's shell would have no npx. Errors
  // are logged and the launch goes on.
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

  const ws = resolveWorkspace(deps.startConfig(), deps);
  if (!ws.ok) return fail(ws.error);

  onState({ phase: "starting_backend", workspace: ws.folder });
  const session = deps.startDeploy(evosci, ws.folder);
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
