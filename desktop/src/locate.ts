// Finding `EvoSci`. The app's PATH is not enough: a PATH that the install
// script changed does not reach an app that was already running. So uv's tool
// bin directory comes first, from `tool dir --bin` run with the uv recorded in
// `<data dir>/tools/uv.json`, else with `uv` on PATH, else `~/.local/bin`;
// then PATH.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const exe = (name: string, platform: NodeJS.Platform) =>
  platform === "win32" ? `${name}.exe` : name;

/** The core's console scripts, as pyproject.toml names them. */
function evosciNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["EvoSci.exe"] : ["EvoSci", "evosci"];
}

/** `file` on PATH, or null. */
export function onPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync
): string | null {
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The uv recorded by the install script, else uv on PATH. */
export function findUv(
  dataDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): string | null {
  try {
    const recorded = JSON.parse(
      readFileSync(join(dataDir, "tools", "uv.json"), "utf-8")
    )?.path;
    if (typeof recorded === "string" && exists(recorded)) return recorded;
  } catch {
    // no record, or an unreadable one
  }
  return onPath(exe("uv", platform), env, exists);
}

export type ToolBinDir = (uv: string) => Promise<string | null>;

/** `uv tool dir --bin`, or null when uv fails or takes too long. */
export const uvToolBinDir =
  (env: NodeJS.ProcessEnv, cwd: string): ToolBinDir =>
  (uv) =>
    new Promise((resolve) => {
      execFile(
        uv,
        ["tool", "dir", "--bin"],
        { env, cwd, windowsHide: true, timeout: 15_000, encoding: "utf8" },
        (err, stdout) => {
          const last = stdout?.trim().split(/\r?\n/).pop()?.trim();
          resolve(err || !last ? null : last);
        }
      );
    });

export interface Located {
  path: string;
  /** Where it was found, for the log. */
  via: "uv-tool-bin" | "local-bin" | "path";
}

export async function locateEvoSci(opts: {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (p: string) => boolean;
  toolBinDir: ToolBinDir;
}): Promise<Located | null> {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const names = evosciNames(platform);
  const uv = findUv(opts.dataDir, opts.env, platform, exists);
  const binDir = uv ? await opts.toolBinDir(uv) : null;
  const dirs: [string, Located["via"]][] = binDir
    ? [[binDir, "uv-tool-bin"]]
    : [[join(opts.home ?? homedir(), ".local", "bin"), "local-bin"]];
  for (const [dir, via] of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return { path: candidate, via };
    }
  }
  for (const name of names) {
    const found = onPath(name, opts.env, exists);
    if (found) return { path: found, via: "path" };
  }
  return null;
}
