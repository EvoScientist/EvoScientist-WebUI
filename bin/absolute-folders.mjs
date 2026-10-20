import { resolve, sep } from "path";

// Python whitespace (`str.isspace()`), as in src/lib/pythonWhitespace.ts: the
// backend treats a value of only these characters as unset.
export const PY_BLANK =
  /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

/** The folders the backend finds from the environment (EvoScientist/paths.py). */
export const FOLDER_VARIABLES = ["EVOSCIENTIST_DATA_DIR", "XDG_CONFIG_HOME"];

/**
 * `env` with each folder variable that holds a relative path resolved against
 * `cwd`. The packaged server changes into its own folder before any route
 * runs, so a relative path would otherwise be read against `dist/`; the
 * backend resolves it against the folder it was started in. Unset or blank
 * values and a leading `~` (alone or before a separator) are left for the
 * server, which expands `~` itself (src/lib/server/paths.ts).
 */
export function absoluteFolderEnv(env, cwd) {
  const out = { ...env };
  for (const key of FOLDER_VARIABLES) {
    const value = out[key];
    if (value === undefined || PY_BLANK.test(value)) continue;
    if (
      value === "~" ||
      value.startsWith("~/") ||
      value.startsWith(`~${sep}`)
    ) {
      continue;
    }
    out[key] = resolve(cwd, value);
  }
  return out;
}
