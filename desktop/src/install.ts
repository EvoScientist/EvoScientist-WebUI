// Installing or repairing the core with the install script the app bundles
// (C10, How > Install script): the command per platform, the checks that come
// before it (Windows on arm64, an update that is still finishing), the copy of
// `config.yaml` before a repair, and the run itself, whose output has no event
// protocol: its lines are shown and logged as they come, and a failure shows
// the output from the last `Error:` line on.
import {
  constants,
  copyFileSync,
  closeSync,
  existsSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { killTree, run, type ExitInfo, type Logger } from "./proc";
import type { Collected } from "./proc";

/** The error codes of this step (How > Deploy errors, [b]). */
export type InstallErrorCode =
  | "install_failed"
  | "unsupported_platform"
  | "update_in_progress";

/** Windows PowerShell 5.1, which every supported Windows has. */
export const powershellPath = (env: NodeJS.ProcessEnv) =>
  join(
    env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );

/**
 * The script-block form (D10, measured before W03b): a script block is not
 * refused by the `Restricted` or `AllSigned` execution policy, as a `-File`
 * would be. The console PowerShell gets under `windowsHide` runs at code page
 * 437 even where the OEM code page is another, so its own lines (the `Error:`
 * line with a path in it) would lose every non-ASCII letter: the output
 * encoding is UTF-8 first. In this form the script reports a failure only
 * through `$LASTEXITCODE`, set to 1 first for failures before its own `try`.
 */
export const POWERSHELL_COMMAND =
  "try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }; " +
  "$global:LASTEXITCODE = 1; " +
  "& ([scriptblock]::Create([IO.File]::ReadAllText($env:EVOSCI_INSTALL_SCRIPT)))";

export interface InstallCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The install script's command: `-Version <ver> -NoSetup [-Cn]`
 * (`--version <ver> --no-setup [--cn]`), since the app runs `EvoSci setup`
 * itself to show its stages. The script puts uv's tool bin folder on the user
 * PATH, as the one-line install does, so `EvoSci` works in a terminal too.
 * `PSModulePath` is left out: a PowerShell 7 parent's value makes Windows
 * PowerShell 5.1 fail to load its own modules (`Get-FileHash` is then "not
 * recognized"; measured).
 */
export function installCommand(opts: {
  platform: NodeJS.Platform;
  scriptsDir: string;
  version: string;
  cn: boolean;
  env: NodeJS.ProcessEnv;
}): InstallCommand {
  if (opts.platform === "win32") {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(opts.env))
      if (k.toUpperCase() !== "PSMODULEPATH") env[k] = v;
    env.EVOSCI_INSTALL_SCRIPT = join(opts.scriptsDir, "install.ps1");
    const options = `-Version ${opts.version} -NoSetup${opts.cn ? " -Cn" : ""}`;
    return {
      file: powershellPath(opts.env),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${POWERSHELL_COMMAND} ${options}; exit $LASTEXITCODE`,
      ],
      env,
    };
  }
  return {
    file: "bash",
    args: [
      join(opts.scriptsDir, "install.sh"),
      "--version",
      opts.version,
      "--no-setup",
      ...(opts.cn ? ["--cn"] : []),
    ],
    env: opts.env,
  };
}

/** The value of `PROCESSOR_ARCHITECTURE` in `reg query` output, or null. */
export function parseRegArchitecture(stdout: string[]): string | null {
  for (const line of stdout) {
    const m = /^\s*PROCESSOR_ARCHITECTURE\s+REG_\w+\s+(\S+)\s*$/i.exec(line);
    if (m) return m[1];
  }
  return null;
}

const ENVIRONMENT_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/**
 * Windows on arm64, read the way the install script reads it: an x64 app
 * under emulation reports x64 for itself in `process.arch` and `os.arch()`,
 * the machine's own value is in the registry (measured on windows-11-arm).
 * When `reg` fails the answer is no: the script itself then refuses.
 */
export async function isWindowsArm64(
  runCollect: (file: string, args: string[]) => Promise<Collected>,
  log: Logger
): Promise<boolean> {
  const r = await runCollect("reg.exe", [
    "query",
    ENVIRONMENT_KEY,
    "/v",
    "PROCESSOR_ARCHITECTURE",
  ]);
  const arch = r.code === 0 ? parseRegArchitecture(r.stdout) : null;
  log.info(`machine architecture: ${arch ?? `unknown (reg exit ${r.code})`}`);
  return arch?.toUpperCase() === "ARM64";
}

/** `<data dir>/tools/update.lock`, held while `EvoSci update` installs. */
export const updateLockPath = (dataDir: string) =>
  join(dataDir, "tools", "update.lock");

/**
 * Whether an update still holds its lock. On Windows the update helper keeps
 * the file open without sharing, so opening it fails with EBUSY (a sharing
 * violation) while it runs; the file stays after the update, so only that
 * state counts. macOS and Linux use `flock`, which Node cannot test (W06).
 */
export function updateLockHeld(
  dataDir: string,
  platform: NodeJS.Platform,
  open: (path: string, flags: string) => number = openSync,
  close: (fd: number) => void = closeSync
): boolean {
  if (platform !== "win32") return false;
  try {
    close(open(updateLockPath(dataDir), "r+"));
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EBUSY";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `config.yaml.bak-YYYYMMDD-HHMMSS`, local time. */
export const backupName = (d: Date) =>
  `config.yaml.bak-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
    d.getDate()
  )}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/**
 * Copies `config.yaml` before a repair: an older release drops the keys it
 * does not know at its next save. Never over an existing backup (`-2`, `-3`,
 * ... within the same second). Returns the backup's path, or null when there
 * is no `config.yaml`. Throws when it cannot copy, and the repair then waits.
 */
export function backupConfig(
  configDir: string,
  now: Date = new Date(),
  copy: (from: string, to: string, mode: number) => void = copyFileSync
): string | null {
  const source = join(configDir, "config.yaml");
  if (!existsSync(source)) return null;
  const base = join(configDir, backupName(now));
  for (let i = 1; i < 100; i++) {
    const target = i === 1 ? base : `${base}-${i}`;
    try {
      copy(source, target, constants.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`too many backups named ${base}`);
}

/** The output to show for a failed run: from the last `Error:` line to the
 *  end, or the last lines when the script printed none. */
export function failureOutput(lines: string[], tail = 20): string[] {
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].startsWith("Error:")) return lines.slice(i);
  return lines.slice(-tail);
}

/** install.ps1's refusal while EvoScientist runs (a repair over a running
 *  core); its lines after `Error:` name the processes. */
export const refusedAsRunning = (output: string[]) =>
  output.some((l) => l.startsWith("Error: EvoScientist is running"));

export interface InstallRun {
  /** Ends with the exit and both output streams closed. */
  done: Promise<{ exit: ExitInfo; lines: string[] }>;
  /** Stops the script and what it started (closing the app, D14). */
  cancel(): Promise<void>;
}

/** Runs the install script, both streams line by line into `onLine` (shown
 *  and logged as they come), in its own process group off Windows. */
export function runInstallScript(
  cmd: InstallCommand,
  opts: {
    cwd: string;
    log: Logger;
    onLine: (line: string) => void;
    platform?: NodeJS.Platform;
  }
): InstallRun {
  const lines: string[] = [];
  const line = (stream: string) => (l: string) => {
    lines.push(l);
    opts.log.info(`install ${stream}: ${l}`);
    opts.onLine(l);
  };
  const r = run(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env: cmd.env,
    group: true,
    onStdoutLine: line("stdout"),
    onStderrLine: line("stderr"),
  });
  r.closeStdin();
  return {
    done: r.closed.then((exit) => ({ exit, lines })),
    cancel: async () => {
      if (r.child.pid)
        await killTree(r.child.pid, opts.log, opts.platform, true);
    },
  };
}
