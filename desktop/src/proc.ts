// Child processes the way the app starts its long-running and streamed ones
// (`EvoSci`, the UI server, `taskkill`): directly, never through a shell (Node destroys a
// child's stdin when that child exits, so an intermediate shell would end the
// stdin of a command that still runs); with three pipes and `windowsHide`;
// and read until both output streams end, not until the process exits. On
// Windows `EvoSci update` hands over to a helper that keeps writing to the
// pipes it inherited after `EvoSci.exe` has exited, and a pipe nobody reads
// blocks its writer after about 128 KiB (measured on windows-latest).
import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { LineSplitter } from "./lines";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Each complete stdout line. */
  onStdoutLine?: (line: string) => void;
  /** Each complete stderr line (stderr is always read, also without this). */
  onStderrLine?: (line: string) => void;
  /** Extra stdio entries after the three pipes, e.g. "ipc" for the UI server. */
  extraStdio?: SpawnOptions["stdio"];
  /** On macOS and Linux, start the child in its own process group, so
   *  `killTree(pid, log, platform, true)` ends what it started too (the
   *  install script's uv or curl). Ignored on Windows, where `detached` would
   *  give the child its own console and take it out of the app's job object;
   *  `taskkill /T` covers the tree there. */
  group?: boolean;
}

export interface Running {
  child: ChildProcess;
  /** The process has exited (its streams may still be open). */
  exited: Promise<ExitInfo>;
  /** The process has exited and both its output streams have ended. */
  closed: Promise<ExitInfo>;
  /** Close stdin: the documented stop signal of `deploy --json` and the UI
   *  server's entry script. Safe to call more than once. */
  closeStdin(): void;
}

/** Starts a child the app's way: no shell, three pipes, hidden window, read until both output streams end. */
export function run(file: string, args: string[], opts: RunOptions): Running {
  const extra = Array.isArray(opts.extraStdio) ? opts.extraStdio : [];
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe", ...extra],
    windowsHide: true,
    shell: false,
    detached: Boolean(opts.group) && process.platform !== "win32",
  });
  const outLines = new LineSplitter();
  const errLines = new LineSplitter();
  const emit = (lines: string[], cb?: (l: string) => void) => {
    if (cb) for (const l of lines) cb(l);
  };
  child.stdout?.on("data", (b: Buffer) =>
    emit(outLines.push(b), opts.onStdoutLine)
  );
  child.stdout?.on("end", () => emit(outLines.end(), opts.onStdoutLine));
  child.stderr?.on("data", (b: Buffer) =>
    emit(errLines.push(b), opts.onStderrLine)
  );
  child.stderr?.on("end", () => emit(errLines.end(), opts.onStderrLine));
  // A stdin write after the child has gone raises EPIPE on the stream.
  child.stdin?.on("error", () => {});

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  // `close` comes after `exit` and after every stdio stream has closed.
  const closed = new Promise<ExitInfo>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return {
    child,
    exited,
    closed,
    closeStdin: () => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    },
  };
}

/** Resolves after `ms`. */
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Resolves with the value, or with "timeout" after `ms`. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number
): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), ms);
    }),
  ]);
}

/** One line of `ps`: a process, its parent and when it started. */
export interface PsRow {
  pid: number;
  ppid: number;
  /** As `ps` prints it; only compared with itself, never parsed. */
  started: string;
}

/** The rows of `ps -axo pid=,ppid=,lstart=`. */
export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3] });
  }
  return rows;
}

/** The process `root` and everything below it by parent links, which hold
 *  across sessions and process groups. Empty when `root` is not listed. */
export function treeOf(rows: PsRow[], root: number): PsRow[] {
  const byParent = new Map<number, PsRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid);
    if (list) list.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const first = rows.find((r) => r.pid === root);
  if (!first) return [];
  const tree = [first];
  const seen = new Set([root]);
  for (let i = 0; i < tree.length; i++)
    for (const child of byParent.get(tree[i].pid) ?? [])
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        tree.push(child);
      }
  return tree;
}

/** `ps`. On macOS by its full path: the app replaces its PATH with the login
 *  shell's, where another `ps` may come first. */
export const PS = process.platform === "darwin" ? "/bin/ps" : "ps";

/** Every process of the system (macOS and Linux), or null when `ps` fails
 *  or takes longer than 5 s. */
export function listProcesses(): Promise<PsRow[] | null> {
  return new Promise((resolve) => {
    execFile(
      PS,
      ["-axo", "pid=,ppid=,lstart="],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : parsePs(stdout))
    );
  });
}

/** How long a tree gets between SIGTERM and SIGKILL. */
export const TREE_GRACE_MS = 5_000;

/**
 * Ends a process and everything it started. On Windows `taskkill /T /F` ends
 * the descendants, itself started with `windowsHide`. Elsewhere the tree is
 * recorded first (once a parent is gone its children hang under pid 1 and
 * cannot be found), then every process in it gets SIGTERM, and what still
 * runs after the grace period gets SIGKILL. The backend's server is a child
 * of `EvoSci deploy` in a session of its own, so a signal to deploy's
 * process group alone would leave it running. A recorded pid is sent SIGKILL
 * only while `ps` still shows it with the same start time, the process
 * itself included, so a pid the system reused meanwhile is left alone. With
 * `group` (a child started with `group: true`) the signals for the process
 * go to its whole process group. Without a process list, or for a process
 * the list does not show, only the process (or its group) is signalled, as
 * before the tree was read.
 */
export async function killTree(
  pid: number,
  log: Logger,
  platform: NodeJS.Platform = process.platform,
  group = false,
  list: () => Promise<PsRow[] | null> = listProcesses
): Promise<void> {
  if (platform === "win32") {
    const k = run("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
      cwd: process.env.SystemRoot ?? "C:\\Windows",
      env: process.env,
      onStdoutLine: (l) => log.info(`taskkill: ${l}`),
      onStderrLine: (l) => log.info(`taskkill: ${l}`),
    });
    const r = await withTimeout(k.closed, 30_000);
    log.info(
      `taskkill /T /F /PID ${pid}: ${
        r === "timeout" ? "timed out" : `exit ${r.code}`
      }`
    );
    return;
  }
  const rows = await list();
  const self = rows?.find((r) => r.pid === pid) ?? null;
  const below = treeOf(rows ?? [], pid).filter((r) => r.pid !== pid);
  // A negative pid signals the process group whose leader is `pid`.
  const target = group ? -pid : pid;
  const what = group ? `process group ${pid}` : `pid ${pid}`;
  const signal = (to: number, name: NodeJS.Signals | 0) => {
    try {
      process.kill(to, name);
      return true;
    } catch {
      return false;
    }
  };
  if (!rows) log.warn(`no process list: ending only pid ${pid}`);
  else if (!self && signal(target, 0))
    log.warn(`pid ${pid} is not in the process list: ending only it`);
  const running = () =>
    signal(target, 0) || below.some((r) => signal(r.pid, 0));
  const reached = signal(target, "SIGTERM");
  for (const r of below) signal(r.pid, "SIGTERM");
  if (!reached && below.length === 0) return;
  for (let i = 0; i < TREE_GRACE_MS / 100 && running(); i++) await sleep(100);
  if (!running()) return;
  // SIGKILL only for what is still the process that was recorded: listed
  // under the same pid with the same start time. A recorded pid that is not
  // listed any more has ended.
  const now = self || below.length ? await list() : null;
  const same = (r: PsRow) =>
    now?.some((n) => n.pid === r.pid && n.started === r.started) === true;
  const listed = (r: PsRow) => now?.some((n) => n.pid === r.pid) === true;
  if (signal(target, 0)) {
    // Not recorded, or no second list: as before the tree was read.
    if (!self || !now || same(self)) {
      log.warn(`${what} did not end on SIGTERM; sending SIGKILL`);
      signal(target, "SIGKILL");
    } else if (listed(self)) {
      log.warn(`pid ${pid} is not the same process any more; left alone`);
    }
  }
  for (const r of below) {
    if (!signal(r.pid, 0)) continue;
    if (!now)
      log.warn(
        `no process list: pid ${r.pid} (started by ${pid}) is left running`
      );
    else if (same(r)) {
      log.warn(`pid ${r.pid} (started by ${pid}) did not end; sending SIGKILL`);
      signal(r.pid, "SIGKILL");
    } else if (listed(r))
      log.warn(
        `pid ${r.pid} is not the process recorded under ${pid} any more; left alone`
      );
  }
}

export interface Collected {
  timedOut: boolean;
  code: number | null;
  stdout: string[];
}

/** A short command (`--version --json`, the node stage): its stdout lines and
 *  exit code, or `timedOut` after `timeoutMs`, when its tree is ended. */
export async function runCollect(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; log: Logger }
): Promise<Collected> {
  const stdout: string[] = [];
  const r = run(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    onStdoutLine: (l) => stdout.push(l),
    onStderrLine: (l) => opts.log.info(`${args[0] ?? file} stderr: ${l}`),
  });
  const exit = await withTimeout(r.closed, opts.timeoutMs);
  if (exit === "timeout") {
    if (r.child.pid) await killTree(r.child.pid, opts.log);
    return { timedOut: true, code: null, stdout };
  }
  return { timedOut: false, code: exit.code, stdout };
}
