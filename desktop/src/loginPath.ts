// The PATH of the user's login shell. An app opened from Finder or the Dock
// gets a minimal PATH from launchd, without Homebrew or `~/.local/bin`, so
// `EvoSci setup` would not see the user's Node and would download its own.
// The app asks the login shell once at startup and gives every child process
// that PATH. Only PATH is taken: other variables a profile sets (a proxy,
// `EVOSCIENTIST_DATA_DIR`) do not reach the app.
//
// A profile can print anything and can leave processes that keep the output
// open, so the environment is printed between two markers that are new for
// each run, reading stops at the end marker, and the shell is ended
// afterwards with the processes below it (one that detached itself from the
// shell on purpose, like an ssh-agent, stays).
//
// A shell that does not take `-ilc` (csh, tcsh) gives no PATH, and the next
// shell is asked.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  PS,
  listProcesses,
  parsePs,
  treeOf,
  type Logger,
  type PsRow,
} from "./proc";

/** How long one shell gets. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Tried after the account's shell, in this order, each at most once. */
export const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];

/** Keeps an oh-my-zsh update prompt and a tmux autostart from holding the
 *  shell until the time limit. */
export const PROBE_ENV = {
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTART: "false",
};

/** The shells to ask: the account's own when it is a full path, then the
 *  fallbacks not in the list yet. */
export function shellsToTry(accountShell: string | null): string[] {
  const shells: string[] = [];
  const own = accountShell?.trim();
  if (own?.startsWith("/")) shells.push(own);
  for (const shell of FALLBACK_SHELLS)
    if (!shells.includes(shell)) shells.push(shell);
  return shells;
}

/** How long the shell waits after the end marker, to be ended by the app. */
const HOLD_SECONDS = 20;

/** The command the shell runs: its environment, NUL-separated, between the
 *  markers, which are letters, digits and underscores only. Then it waits
 *  instead of ending: a shell that ended by itself would leave what its
 *  profile started in the background under pid 1, where the app could not
 *  find it any more. The app ends the shell at the end marker; left alone
 *  (the app died) it ends after the wait. */
export function probeScript(start: string, end: string): string {
  return `printf '%s' '${start}'; /usr/bin/env -0; printf '%s' '${end}'; /bin/sleep ${HOLD_SECONDS}`;
}

/** PATH from the block between the markers; null when a marker or PATH is
 *  missing or PATH is empty. */
export function pathBetween(
  output: string,
  start: string,
  end: string
): string | null {
  const from = output.indexOf(start);
  if (from === -1) return null;
  const to = output.indexOf(end, from + start.length);
  if (to === -1) return null;
  for (const entry of output.slice(from + start.length, to).split("\0"))
    if (entry.startsWith("PATH=")) return entry.slice("PATH=".length) || null;
  return null;
}

/** Runs `script` in a shell: its output up to the end marker, "timeout", or
 *  null when the shell could not start or ended without the marker. */
export type Probe = (
  shell: string,
  script: string,
  timeoutMs: number,
  end: string
) => Promise<string | "timeout" | null>;

/** The probe shells that have not been ended yet, each with the call that
 *  settles its probe. */
const asked = new Map<number, () => void>();

/**
 * Ends every shell that is still being asked, at once and with what it
 * started: the app quits, and its timers and callbacks will not run any
 * more. A profile that hangs would otherwise stay behind.
 */
export function endProbes(): void {
  if (asked.size === 0) return;
  let rows: PsRow[] = [];
  try {
    rows = parsePs(
      execFileSync(PS, ["-axo", "pid=,ppid=,lstart="], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    );
  } catch {
    // Without a list only the shells' process groups are ended.
  }
  for (const [pid, settle] of [...asked]) {
    asked.delete(pid);
    endTree(rows, pid);
    settle();
  }
}

/** SIGKILL to the process group the shell leads (it is `detached`) and to
 *  every process below it: an interactive shell gives each job a process
 *  group of its own, so the group signal alone misses them. */
function endTree(rows: PsRow[], pid: number): void {
  for (const target of [-pid, ...ownTree(rows, pid, process.pid)]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** The pids below the shell `pid`, but only while `pid` is still the child
 *  of `parent` (this app): once the shell has ended, its pid may belong to
 *  another process, whose children are not the app's to end. */
export function ownTree(rows: PsRow[], pid: number, parent: number): number[] {
  if (rows.find((r) => r.pid === pid)?.ppid !== parent) return [];
  return treeOf(rows, pid)
    .map((r) => r.pid)
    .filter((p) => p !== pid);
}

/**
 * The real probe: `<shell> -ilc <script>` (login and interactive, so both
 * kinds of profile are read) with stdin closed, in a process group of its
 * own. It answers as soon as the end marker is in the output and never waits
 * for the output to close. Either way the shell is then ended with what its
 * profile started: its process group and, since an interactive shell gives
 * each background job a group of its own, every process below it.
 */
export function probeShell(
  shell: string,
  script: string,
  timeoutMs: number,
  end: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | "timeout" | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, ["-ilc", script], {
        env: { ...env, ...PROBE_ENV },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      // Not something that can be run (ENOTDIR, ENOEXEC): spawn throws
      // instead of reporting an error later.
      return resolve(null);
    }
    const pid = child.pid;
    let output = "";
    let settled = false;
    const finish = (result: string | "timeout" | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(result);
      if (pid && asked.delete(pid)) void endShell(pid);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (pid) asked.set(pid, () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      const at = output.indexOf(end);
      if (at !== -1) finish(output.slice(0, at + end.length));
    });
    child.once("error", () => finish(null));
    child.once("close", () => finish(null));
  });
}

/** Ends the shell with what it started. The processes are listed first:
 *  once the shell is gone, what it started hangs under pid 1. */
async function endShell(pid: number): Promise<void> {
  endTree((await listProcesses()) ?? [], pid);
}

/**
 * The login shell's PATH and the shell it came from, or null when no shell
 * gave one (the app then keeps the PATH it inherited). Each shell is asked
 * once, with markers of its own.
 */
export async function readLoginPath(opts: {
  /** From the account record (`os.userInfo().shell`), not `$SHELL`: an app
   *  opened from Finder inherits that from launchd. */
  accountShell: string | null;
  log: Logger;
  probe?: Probe;
  timeoutMs?: number;
}): Promise<{ path: string; shell: string } | null> {
  const probe = opts.probe ?? probeShell;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const shells = shellsToTry(opts.accountShell);
  for (const [i, shell] of shells.entries()) {
    const id = randomBytes(8).toString("hex");
    const start = `__EVOSCI_ENV_${id}_START__`;
    const end = `__EVOSCI_ENV_${id}_END__`;
    const next = shells[i + 1] ? `; trying ${shells[i + 1]}` : "";
    const output = await probe(shell, probeScript(start, end), timeoutMs, end);
    if (output === "timeout") {
      opts.log.warn(
        `${shell} did not answer in ${Math.round(timeoutMs / 1000)} s${next}`
      );
      continue;
    }
    const path = output === null ? null : pathBetween(output, start, end);
    if (path) {
      opts.log.info(
        `login shell PATH from ${shell} (${path.split(":").length} entries)`
      );
      return { path, shell };
    }
    opts.log.warn(`${shell} gave no PATH${next}`);
  }
  opts.log.warn("no login shell answered; keeping the inherited PATH");
  return null;
}
