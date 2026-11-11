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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { listProcessesNow, treeOf, type Logger } from "./proc";

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

/** More output than this (in characters) without the end marker is not an
 *  environment. */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

/** A shell that is being asked: its probe has no answer yet. */
interface Asked {
  /** Settles its probe (with null) and ends the shell. */
  settle(): void;
}
const asked = new Map<number, Asked>();

/** The app quits: no shell is asked from now on. */
let ended = false;

/**
 * Ends every shell that is still being asked, at once and with what it
 * started, and stops asking: the app quits, and its timers and callbacks
 * will not run any more. A profile that hangs would otherwise stay behind.
 */
export function endProbes(): void {
  ended = true;
  for (const probe of [...asked.values()]) probe.settle();
}

/**
 * Ends a shell that still runs, with what it started: SIGKILL to the
 * process group it leads (it is `detached`) and to every process below it,
 * since an interactive shell may give each job a process group of its own.
 * All in one step, so nothing is left for a later turn that may not come
 * (the app quits), and the shell is never only stopped. The processes are
 * listed first: once the shell is gone, what it started hangs under pid 1.
 * Without a list (`ps` failed) only the group is ended.
 *
 * The list and the signals are not one moment for the shell: a profile that
 * is still starting commands (the time limit, the output limit or a quit
 * came while it ran) can start one after the list, and with job control
 * (bash) that command has a group of its own and runs on. At the end marker
 * the shell waits in its last command and starts nothing.
 */
function endShell(pid: number): void {
  const below = treeOf(listProcessesNow() ?? [], pid)
    .map((r) => r.pid)
    .filter((p) => p !== pid);
  for (const target of [-pid, ...below]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * The real probe: `<shell> -ilc <script>` (login and interactive, so both
 * kinds of profile are read) with stdin closed, in a process group of its
 * own. It answers as soon as the end marker is in the output and never waits
 * for the output to close. A shell that still runs then has been ended with
 * what its profile started by the time the probe answers. A shell that has
 * ended by itself gets no signal: its pid and the number of its process
 * group may belong to another process by then.
 */
export function probeShell(
  shell: string,
  script: string,
  timeoutMs: number,
  end: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | "timeout" | null> {
  if (ended) return Promise.resolve(null);
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
      if (pid) {
        asked.delete(pid);
        // Node has not seen it end: the pid and the group are still its own.
        if (child.exitCode === null && child.signalCode === null) endShell(pid);
      }
      // After the shell is gone: a shell whose output is cut off goes on to
      // its next command.
      child.stdout?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (pid) asked.set(pid, { settle: () => finish(null) });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      // The marker may straddle two chunks; what came before was searched.
      const from = Math.max(0, output.length - end.length);
      output += chunk;
      const at = output.indexOf(end, from);
      if (at !== -1) finish(output.slice(0, at + end.length));
      else if (output.length > MAX_OUTPUT_CHARS) finish(null);
    });
    child.once("error", () => finish(null));
    child.once("close", () => finish(null));
  });
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
    // The app quits (endProbes): the shell that was being asked gave
    // nothing, and no other is started.
    if (ended && !path) return null;
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
