// Child processes the way the app starts every one of them (`EvoSci`, the UI
// server, `taskkill`): directly, never through a shell (Node destroys a
// child's stdin when that child exits, so an intermediate shell would end the
// stdin of a command that still runs); with three pipes and `windowsHide`;
// and read until both output streams end, not until the process exits. On
// Windows `EvoSci update` hands over to a helper that keeps writing to the
// pipes it inherited after `EvoSci.exe` has exited, and a pipe nobody reads
// blocks its writer after about 128 KiB (measured on windows-latest).
import {
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

export function run(file: string, args: string[], opts: RunOptions): Running {
  const extra = Array.isArray(opts.extraStdio) ? opts.extraStdio : [];
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe", ...extra],
    windowsHide: true,
    shell: false,
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

/**
 * Ends a process and its descendants. On Windows `taskkill /T /F`, itself
 * started with `windowsHide`; elsewhere SIGTERM, then SIGKILL after a grace
 * period (macOS and Linux packaging is W06).
 */
export async function killTree(
  pid: number,
  log: Logger,
  platform: NodeJS.Platform = process.platform
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
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 50 && alive(); i++) await sleep(100);
  if (alive()) {
    log.warn(`pid ${pid} did not end on SIGTERM; sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
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
