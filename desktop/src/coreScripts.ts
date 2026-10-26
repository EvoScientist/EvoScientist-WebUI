// The core's install scripts that the app bundles (C10): `install.ps1` and
// `install.sh` from the core's tag `v<installVersion(coreRange)>`, the tag
// whose constraints.txt the script installs. The desktop build downloads them
// (scripts/fetch-core-scripts.mjs) and fails if either is missing; the
// packaging step checks them again (scripts/before-pack.cjs). Core releases
// are immutable, so a tag always names the same files.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CORE_SCRIPTS = ["install.ps1", "install.sh"] as const;
export type CoreScript = (typeof CORE_SCRIPTS)[number];

/** Raw files of the core repository at a tag. */
export const CORE_SCRIPTS_BASE =
  "https://raw.githubusercontent.com/EvoScientist/EvoScientist/refs/tags";

/** What was downloaded, written next to the scripts as `source.json`. */
export interface CoreScriptsSource {
  version: string;
  files: Record<CoreScript, string>;
}

export const SOURCE_FILE = "source.json";

/** The URL of one script at the core's tag for `version`. */
export const coreScriptUrl = (base: string, version: string, name: string) =>
  `${base}/v${version}/scripts/${name}`;

/**
 * Downloads both scripts for `version` into `outDir`, replacing what was
 * there, and writes `source.json` last: a download that fails part-way leaves
 * no `source.json`, so the packaging check refuses it.
 */
export async function fetchCoreScripts(opts: {
  version: string;
  outDir: string;
  base?: string;
  fetch?: typeof fetch;
}): Promise<CoreScriptsSource> {
  const get = opts.fetch ?? fetch;
  const base = opts.base ?? CORE_SCRIPTS_BASE;
  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });
  const files = {} as Record<CoreScript, string>;
  for (const name of CORE_SCRIPTS) {
    const url = coreScriptUrl(base, opts.version, name);
    const res = await get(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0) throw new Error(`${url}: empty`);
    writeFileSync(join(opts.outDir, name), body);
    files[name] = url;
  }
  const source: CoreScriptsSource = { version: opts.version, files };
  writeFileSync(
    join(opts.outDir, SOURCE_FILE),
    JSON.stringify(source, null, 2) + "\n"
  );
  return source;
}

/** Why the scripts in `dir` cannot be bundled for `version`, or null when
 *  both are there and were downloaded for that version. */
export function coreScriptsProblem(
  dir: string,
  version: string
): string | null {
  let source: Partial<CoreScriptsSource>;
  try {
    source = JSON.parse(readFileSync(join(dir, SOURCE_FILE), "utf8"));
  } catch {
    return `no ${SOURCE_FILE} in ${dir}: run npm run fetch-core-scripts`;
  }
  if (source.version !== version)
    return `the scripts in ${dir} are for ${source.version}, the app installs ${version}: run npm run fetch-core-scripts`;
  const missing = CORE_SCRIPTS.filter((n) => !existsSync(join(dir, n)));
  return missing.length > 0 ? `missing in ${dir}: ${missing.join(", ")}` : null;
}
