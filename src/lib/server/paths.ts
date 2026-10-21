// EvoScientist's folders, found the way the backend finds them
// (EvoScientist/paths.py), so the WebUI, the desktop app and the backend agree
// on one data folder and one config folder.

import { homedir } from "os";
import { join, resolve, sep } from "path";
import { pyStrip } from "@/lib/pythonWhitespace";

/**
 * A folder other programs locate too, read from the environment variable `key`
 * with the backend's rule (`_shared_dir_from_env()` in paths.py): an unset,
 * empty or whitespace-only value counts as unset; a leading `~`, alone or
 * followed by a path separator, is the home folder, and nothing else is
 * expanded (`~name` stays a relative path); a relative path is resolved against
 * the current folder. Returns null when the variable is unset.
 *
 * The packaged server changes into its own folder before any route runs, so
 * `bin/evoscientist-webui.mjs` makes these variables absolute first.
 */
export function sharedDirFromEnv(
  key: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  const value = env[key];
  if (value === undefined || pyStrip(value) === "") return null;
  const expanded =
    value === "~" || value.startsWith("~/") || value.startsWith(`~${sep}`)
      ? homedir() + value.slice(1)
      : value;
  return resolve(expanded);
}

/** EvoScientist's data folder: `$EVOSCIENTIST_DATA_DIR`, by default
 *  `~/.evoscientist` (skills, memories, the server home). */
export function globalDataDir(): string {
  return (
    sharedDirFromEnv("EVOSCIENTIST_DATA_DIR") ??
    join(homedir(), ".evoscientist")
  );
}

/** EvoScientist's config folder: `$XDG_CONFIG_HOME/evoscientist`, by default
 *  `~/.config/evoscientist` (config.yaml, mcp.yaml). The backend's runtime
 *  files (log, pid, workspace sidecar) do not move with it. */
export function configDir(): string {
  return join(
    sharedDirFromEnv("XDG_CONFIG_HOME") ?? join(homedir(), ".config"),
    "evoscientist"
  );
}
