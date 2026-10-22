// One `EvoSci deploy --json` process (C13): started without `--workdir` in the
// workspace folder, read until it prints `ready` or `error`, watched for
// `backend_exited` or its own exit afterwards, and stopped the documented way:
// close its stdin, wait for `stopped`, then end its process tree.
import { parseDeployEvent, type DeployError, type DeployReady } from "./lines";
import { killTree, run, withTimeout, type Logger, type Running } from "./proc";

/** How long `deploy` gets after its stdin closes before its tree is ended.
 *  Its own stop takes up to about 14.5 s (D7, accepted on the issue). */
export const DEPLOY_STOP_MS = 20_000;

export type DeployOutcome =
  | { kind: "ready"; ready: DeployReady }
  | { kind: "error"; error: DeployError };

export interface DeploySession {
  /** The first `ready` or `error`; an exit before either is an `internal_error`. */
  outcome: Promise<DeployOutcome>;
  /** After `ready`: the backend went away (`backend_exited`, or `deploy` exited). */
  onLost(cb: (error: DeployError) => void): void;
  /** Close stdin, wait for `stopped` up to DEPLOY_STOP_MS, then end the tree. */
  stop(): Promise<"stopped" | "killed">;
  /** The end of the session, synchronous: close stdin and return (D5). */
  closeStdinNow(): void;
  pid: number | undefined;
}

export interface DeployDeps {
  log: Logger;
  /** Starts the process; `run` from proc.ts, replaceable in tests. */
  spawn?: typeof run;
  kill?: (pid: number) => Promise<void>;
}

export function startDeploy(
  evosci: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  deps: DeployDeps
): DeploySession {
  const spawnFn = deps.spawn ?? run;
  const kill = deps.kill ?? ((pid: number) => killTree(pid, deps.log));
  let settled = false;
  let stopping = false;
  let stopped = false;
  let lostCb: ((e: DeployError) => void) | null = null;
  let lostReported = false;
  let resolveOutcome!: (o: DeployOutcome) => void;
  const outcome = new Promise<DeployOutcome>((r) => (resolveOutcome = r));

  const lose = (error: DeployError) => {
    if (stopping || lostReported) return;
    lostReported = true;
    deps.log.warn(`backend lost: ${error.code} ${error.message}`);
    lostCb?.(error);
  };

  const proc: Running = spawnFn(evosci, ["deploy", "--json"], {
    cwd: workspace,
    env,
    onStdoutLine: (line) => {
      const ev = parseDeployEvent(line);
      if (!ev) {
        if (line.trim()) deps.log.info(`deploy: ${line}`);
        return;
      }
      deps.log.info(`deploy event: ${line}`);
      if (ev.event === "ready" && !settled) {
        settled = true;
        resolveOutcome({ kind: "ready", ready: ev });
      } else if (ev.event === "error") {
        if (!settled) {
          settled = true;
          resolveOutcome({ kind: "error", error: ev });
        } else {
          lose(ev);
        }
      } else if (ev.event === "stopped") {
        stopped = true;
      }
    },
    onStderrLine: (line) => deps.log.info(`deploy stderr: ${line}`),
  });

  proc.exited.then((exit) => {
    const error: DeployError = {
      event: "error",
      code: settled ? "backend_exited" : "internal_error",
      message: `EvoSci deploy exited (code ${exit.code}${
        exit.signal ? `, signal ${exit.signal}` : ""
      })`,
      detail: { exit_code: exit.code },
    };
    if (!settled) {
      settled = true;
      resolveOutcome({ kind: "error", error });
    } else {
      lose(error);
    }
  });

  return {
    outcome,
    pid: proc.child.pid,
    onLost: (cb) => {
      lostCb = cb;
    },
    closeStdinNow: () => {
      stopping = true;
      proc.closeStdin();
    },
    stop: async () => {
      stopping = true;
      proc.closeStdin();
      // An exit is the end either way; the `stopped` line is logged when missing.
      const r = await withTimeout(proc.exited, DEPLOY_STOP_MS);
      if (r !== "timeout") {
        if (!stopped) deps.log.warn("deploy exited without a stopped line");
        return "stopped";
      }
      deps.log.warn(
        `deploy did not stop within ${DEPLOY_STOP_MS} ms (stopped line: ${stopped}); ending its tree`
      );
      if (proc.child.pid) await kill(proc.child.pid);
      return "killed";
    },
  };
}
