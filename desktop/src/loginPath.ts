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
// afterwards with everything it started.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { listProcesses, treeOf, type Logger } from "./proc";

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

/** The command the shell runs: its environment, NUL-separated, between the
 *  markers. The markers are letters, digits and underscores only. */
export function probeScript(start: string, end: string): string {
  return `printf '%s' '${start}'; /usr/bin/env -0; printf '%s' '${end}'`;
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
    const child = spawn(shell, ["-ilc", script], {
      env: { ...env, ...PROBE_ENV },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let output = "";
    let settled = false;
    const finish = (result: string | "timeout" | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolve(result);
      if (child.pid) void endShell(child.pid);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
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

/** Ends the shell's process group (it leads one, being `detached`) and every
 *  process below it. The processes are listed first: once the shell is gone,
 *  what it started hangs under pid 1. */
async function endShell(pid: number): Promise<void> {
  const below = treeOf((await listProcesses()) ?? [], pid);
  for (const target of [-pid, ...below.map((r) => r.pid)]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
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
