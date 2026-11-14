// EvoScientist's folders and the three config.yaml keys the app needs before a
// backend answers, found the way the core finds them (EvoScientist/paths.py,
// config/settings.py) and the way the WebUI's server does
// (src/lib/server/paths.ts, coreConfig.ts).
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { join, resolve, sep } from "node:path";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";

export type Env = Record<string, string | undefined>;

// Python's str.isspace() set: `\s` in JS takes U+FEFF and leaves out
// U+001C to U+001F and U+0085.
// U+001C to U+001F are control characters, and Python whitespace too.
/* eslint-disable no-control-regex */
const PY_SPACE = new RegExp(
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]"
);
/* eslint-enable no-control-regex */

export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_SPACE.test(text[start])) start++;
  while (end > start && PY_SPACE.test(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * A folder other programs locate too, from the variable `key`, with the core's
 * rule (`_shared_dir_from_env()`): unset, empty or whitespace-only counts as
 * unset; a leading `~`, alone or followed by a separator, is the home folder,
 * nothing else is expanded; a relative path resolves against the current
 * folder. Always absolute.
 */
export function sharedDirFromEnv(
  key: string,
  env: Env,
  home = homedir()
): string | null {
  const value = env[key];
  if (value === undefined || pyStrip(value) === "") return null;
  const expanded =
    value === "~" || value.startsWith("~/") || value.startsWith(`~${sep}`)
      ? home + value.slice(1)
      : value;
  return resolve(expanded);
}

export interface Folders {
  /** `$EVOSCIENTIST_DATA_DIR`, else `~/.evoscientist`. */
  dataDir: string;
  /** `$XDG_CONFIG_HOME/evoscientist`, else `~/.config/evoscientist`. */
  configDir: string;
  /** Whether the app's own environment sets `XDG_CONFIG_HOME`. */
  xdgConfigHomeSet: boolean;
}

/** The data and config folders from the app's environment, as the core resolves them. */
export function resolveFolders(env: Env, home = homedir()): Folders {
  const xdg = sharedDirFromEnv("XDG_CONFIG_HOME", env, home);
  return {
    dataDir:
      sharedDirFromEnv("EVOSCIENTIST_DATA_DIR", env, home) ??
      join(home, ".evoscientist"),
    configDir: join(xdg ?? join(home, ".config"), "evoscientist"),
    xdgConfigHomeSet: xdg !== null,
  };
}

/**
 * The folder variables for every `EvoSci` child, as the core's
 * `paths.dir_env()` passes them to its own children: `EVOSCIENTIST_DATA_DIR`
 * always, absolute; `XDG_CONFIG_HOME` only when the app's environment sets it,
 * and removed otherwise.
 */
export function folderEnv(env: Env, folders: Folders): Env {
  const out: Env = { ...env, EVOSCIENTIST_DATA_DIR: folders.dataDir };
  if (folders.xdgConfigHomeSet)
    out.XDG_CONFIG_HOME = resolve(folders.configDir, "..");
  else delete out.XDG_CONFIG_HOME;
  return out;
}

export const BACKEND_LOG = "langgraph_dev.log";

/**
 * Where the backend keeps its log, newest first: the server home in the data
 * folder, then `~/.config/evoscientist` whatever `XDG_CONFIG_HOME` says,
 * where older cores keep it.
 */
export function runtimeDirs(dataDir: string, home = homedir()): string[] {
  return [join(dataDir, "server"), join(home, ".config", "evoscientist")];
}

/**
 * Where the backend's log is before `ready` names it: the first of `dirs`
 * that holds it, else the first, the server home, where the core the app
 * installs keeps it (cores from 0.4.2 on). Where the app's own logs open is
 * logFolder's choice.
 */
export function runtimeDir(
  dirs: string[],
  exists: (path: string) => boolean
): string {
  return dirs.find((dir) => exists(join(dir, BACKEND_LOG))) ?? dirs[0];
}

/**
 * Makes the server home as the core makes it, readable by its owner only
 * (`0700`; the folders above it with the usual mode, as the core makes the
 * data folder). The core narrows a server home that others can read, and then
 * warns that its local secret may have been exposed. One that exists is left
 * as it is. Not for Windows, where Node ignores the mode (see logFolder).
 */
export function ensureServerHome(path: string): void {
  mkdirSync(nodePath.dirname(path), { recursive: true });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/** Whether `path` is a folder this account can make files in. Node does not
 *  read a folder's access list on Windows, so there it says whether the folder
 *  exists. */
export function writableFolder(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the app's own logs open at its start, before `ready` names the
 * backend's log; `dirs` are runtimeDirs' two folders. The first that holds
 * the backend's log and can be written to, else the server home. One the
 * core has not made yet the app makes as the core does (`makeServerHome`),
 * but not on Windows: a folder Node makes there takes the access of the
 * folder above it, where the core's Python makes one that only its owner can
 * open, and the core does not narrow it later. There the logs open in the
 * older folder until `ready` names the backend's. So they do wherever the
 * server home cannot be made or written to, and then `problem` says why
 * (`sudo EvoSci` can leave one that belongs to root; a link to a volume that
 * is not mounted makes no folder).
 */
export function logFolder(
  dirs: string[],
  disk: {
    exists: (path: string) => boolean;
    writable: (path: string) => boolean;
  },
  platform: NodeJS.Platform,
  makeServerHome: (path: string) => void
): { dir: string; problem: string | null } {
  const [serverHome, older] = dirs;
  const cannotWrite = {
    dir: older,
    problem: "it is not a folder this account can write to",
  };
  const withLog = dirs.find(
    (dir) => disk.exists(join(dir, BACKEND_LOG)) && disk.writable(dir)
  );
  if (withLog !== undefined) return { dir: withLog, problem: null };
  if (disk.exists(serverHome))
    return disk.writable(serverHome)
      ? { dir: serverHome, problem: null }
      : cannotWrite;
  if (platform === "win32") return { dir: older, problem: null };
  try {
    makeServerHome(serverHome);
  } catch (e) {
    return { dir: older, problem: e instanceof Error ? e.message : String(e) };
  }
  return disk.writable(serverHome)
    ? { dir: serverHome, problem: null }
    : cannotWrite;
}

/**
 * `ready`'s folder fields, with the app's own folders for any the core left
 * out (a contract slip: the core always sends them). An empty log file would
 * move the app's logs into its working directory and an empty data folder
 * would reach the UI server as `EVOSCIENTIST_DATA_DIR=""`. `missing` names
 * the fields that were filled in.
 */
export function withReadyFolders<
  R extends { dataDir: string; configDir: string; logFile: string }
>(
  ready: R,
  folders: Folders,
  exists: (path: string) => boolean,
  home = homedir()
): { ready: R; missing: string[] } {
  const missing: string[] = [];
  const pick = (value: string, field: string, fallback: string) => {
    if (value) return value;
    missing.push(field);
    return fallback;
  };
  const dataDir = pick(ready.dataDir, "data_dir", folders.dataDir);
  return {
    ready: {
      ...ready,
      dataDir,
      configDir: pick(ready.configDir, "config_dir", folders.configDir),
      logFile: pick(
        ready.logFile,
        "log_file",
        join(runtimeDir(runtimeDirs(dataDir, home), exists), BACKEND_LOG)
      ),
    },
    missing,
  };
}

export const DEFAULT_BACKEND_PORT = 6174;

export interface StartConfig {
  /** `EVOSCIENTIST_WORKSPACE_DIR`, else `default_workdir`; null when neither is set. */
  defaultWorkdir: string | null;
  /** `EVOSCIENTIST_LANGGRAPH_DEV_PORT`, else `langgraph_dev_port`, else 6174. */
  port: number;
  /** `mirror`; only "cn" means mainland China mirrors. */
  mirror: string | null;
}

/** Reads config.yaml with the core's YAML rules; a missing or unparseable file,
 *  or one whose top level is not a mapping, counts as empty. */
export function readConfigFile(configDir: string): Record<string, unknown> {
  try {
    const data = loadYaml(
      readFileSync(join(configDir, "config.yaml"), "utf-8"),
      { schema: CORE_SCHEMA }
    );
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A port number from a number or a digit string, or null when it is not 1 to 65535. */
function validPort(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** The string when it is not blank (Python's strip rule), else null. */
const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && pyStrip(v) !== "" ? v : null;

/** The three keys, and nothing else, with the app's environment winning over
 *  the file for the folder and the port, as in the core. */
export function readStartConfig(configDir: string, env: Env): StartConfig {
  const file = readConfigFile(configDir);
  return {
    defaultWorkdir:
      nonEmpty(env.EVOSCIENTIST_WORKSPACE_DIR) ??
      nonEmpty(file.default_workdir),
    port:
      validPort(env.EVOSCIENTIST_LANGGRAPH_DEV_PORT) ??
      validPort(file.langgraph_dev_port) ??
      DEFAULT_BACKEND_PORT,
    mirror: nonEmpty(file.mirror),
  };
}

/** A leading `~` expanded, then absolute, as the core's `start_workspace_path()`
 *  treats `default_workdir` (`os.path.expanduser`, then `abspath`). */
export function expandWorkdir(value: string, home = homedir()): string {
  const expanded =
    value === "~" || value.startsWith("~/") || value.startsWith(`~${sep}`)
      ? home + value.slice(1)
      : value;
  return resolve(expanded);
}

/**
 * A folder in the form the core keys projects by, as its non-strict
 * `Path.resolve()` spells it: the real path of the nearest existing folder
 * on the way up, with the missing rest as typed; forward slashes on Windows;
 * no trailing slash except on a root (`C:/`, `/`).
 */
export function folderKey(
  folder: string,
  path: Pick<
    typeof nodePath,
    "resolve" | "dirname" | "basename" | "join" | "sep"
  > = nodePath,
  realpath: (p: string) => string = realpathSync.native
): string {
  let full = path.resolve(folder);
  const missing: string[] = [];
  for (let current = full; ; ) {
    try {
      full = path.resolve(path.join(realpath(current), ...missing));
      break;
    } catch {
      const parent = path.dirname(current);
      // Nothing on the way up resolves: the absolute path stands.
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  // resolve() leaves no trailing separator except on a root.
  return path.sep === "\\" ? full.replaceAll("\\", "/") : full;
}
