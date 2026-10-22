// EvoScientist's folders and the three config.yaml keys the app needs before a
// backend answers, found the way the core finds them (EvoScientist/paths.py,
// config/settings.py) and the way the WebUI's server does
// (src/lib/server/paths.ts, coreConfig.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Where the backend's log, and so the app's own logs, live before the first
 * `ready`: `~/.config/evoscientist` whatever `XDG_CONFIG_HOME` or
 * `EVOSCIENTIST_DATA_DIR` say, until the core moves its runtime files (C18).
 */
export function runtimeDir(home = homedir()): string {
  return join(home, ".config", "evoscientist");
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

function validPort(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

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
