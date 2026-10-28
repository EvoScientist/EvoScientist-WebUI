// `EvoSci update --version <v> --skip webui --json` (C11, How > Core update):
// its own progress, the setup stages of the new version that it forwards in
// the same stream, the processes it waits for, and its outcome. The outcome
// is the `update` stage's terminal line, the last line it writes: on Windows
// `EvoSci.exe` exits 0 at the handover to its helper, which writes the rest
// to the inherited pipes, so the exit code says nothing and the run counts as
// over only when both streams have closed. The update is never killed (a
// killed updater leaves no terminal line, and on Windows the helper outlives
// it): while it waits, it is cancelled through the file its waiting line
// names, and it then ends with `environment_busy`. The app never passes
// `--yes`, so a backend it did not start ends the update with
// `server_running`, and it always passes `--version`.
import { writeFileSync } from "node:fs";
import { parseStageEvent, type StageEvent } from "./lines";
import { run, type ExitInfo, type Logger } from "./proc";
import { applyStageEvent, SKIPPED_STAGES, type Stage } from "./setup";

/** The arguments of the update to `version`. */
export const updateArgs = (version: string) => [
  "update",
  "--version",
  version,
  ...SKIPPED_STAGES.flatMap((s) => ["--skip", s]),
  "--json",
];

/** One process the update waits for (`detail.waiting_for`). */
export interface Blocker {
  pid: number;
  name: string;
  path: string;
}

export interface UpdateView {
  /** The `update` stage's latest progress line. */
  update: { progress?: number; message?: string };
  /** The new version's setup stages, from the manifest and the update's lines. */
  stages: Stage[];
  /** The processes it waits for; null while it does not wait. */
  waiting: Blocker[] | null;
}

export type UpdateOutcome =
  | { kind: "done"; version: string | null; message?: string }
  | {
      kind: "error";
      code: string;
      message: string;
      detail: Record<string, unknown>;
    }
  /** The streams closed without the `update` stage's terminal line. */
  | { kind: "no_terminal_line"; exit: ExitInfo };

/** The waiting line's process list, or null when the line has none. */
function blockers(e: StageEvent): Blocker[] | null {
  const list = e.detail.waiting_for;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map((b) => {
    const v = (b ?? {}) as Record<string, unknown>;
    return {
      pid: typeof v.pid === "number" ? v.pid : 0,
      name: typeof v.name === "string" ? v.name : "",
      path: typeof v.path === "string" ? v.path : "",
    };
  });
}

/**
 * Reads the update's stdout lines into the view, the cancel file and the
 * outcome. No line clears the waiting list when the processes have gone: the
 * next `update` line without `waiting_for` ends the wait (measured).
 */
export class UpdateReader {
  view: UpdateView;
  /** The cancel file of the latest waiting line. */
  cancelFile: string | null = null;
  terminal: StageEvent | null = null;

  constructor(stages: Stage[]) {
    this.view = { update: {}, stages, waiting: null };
  }

  /** Applies one stdout line; true when the view changed. */
  push(line: string): boolean {
    const e = parseStageEvent(line);
    if (!e) return false;
    if (e.stage !== "update") {
      this.view = {
        ...this.view,
        stages: applyStageEvent(this.view.stages, e),
      };
      return true;
    }
    if (e.status !== "running") {
      this.terminal = e;
      this.view = { ...this.view, waiting: null };
      return true;
    }
    const waiting = blockers(e);
    const cancel = e.detail.cancel_file;
    if (waiting && typeof cancel === "string" && cancel)
      this.cancelFile = cancel;
    this.view = {
      ...this.view,
      update: { progress: e.progress, message: e.message },
      waiting,
    };
    return true;
  }

  /** The outcome once both streams have closed. */
  outcome(exit: ExitInfo): UpdateOutcome {
    const t = this.terminal;
    if (!t) return { kind: "no_terminal_line", exit };
    if (t.status === "error")
      return {
        kind: "error",
        code: t.code ?? "update_failed",
        message: t.message ?? "EvoSci update failed.",
        detail: t.detail,
      };
    const version = t.detail.version;
    return {
      kind: "done",
      version: typeof version === "string" ? version : null,
      message: t.message,
    };
  }
}

export interface UpdateRun {
  /** Ends when both output streams have closed. */
  done: Promise<{ outcome: UpdateOutcome; view: UpdateView }>;
  /** Cancels the update while it waits for processes, and from then on as
   *  soon as it waits (closing the app). True when the file was written now. */
  cancelWhenWaiting(): boolean;
  /** Cancels the update only if it waits for processes now (the waiting
   *  screen's button): a click after the wait has ended does nothing. */
  cancelNow(): boolean;
  /** Whether it waits for processes now. */
  waiting(): boolean;
}

/** Runs the update; `onUpdate` gets the view after every line that changes it. */
export function runUpdate(
  evosci: string,
  opts: {
    version: string;
    stages: Stage[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: Logger;
    onUpdate: (view: UpdateView) => void;
    /** Creates the cancel file (tests replace it). */
    touch?: (path: string) => void;
  }
): UpdateRun {
  const reader = new UpdateReader(opts.stages);
  const touch = opts.touch ?? ((p: string) => writeFileSync(p, ""));
  let cancelRequested = false;
  let cancelled = false;

  const cancelNow = (): boolean => {
    if (cancelled || !reader.view.waiting || !reader.cancelFile) return false;
    try {
      touch(reader.cancelFile);
      cancelled = true;
      opts.log.info(`update: created the cancel file ${reader.cancelFile}`);
      return true;
    } catch (e) {
      opts.log.warn(`update: cannot create ${reader.cancelFile}: ${e}`);
      return false;
    }
  };

  // stdin stays an open pipe: under `--json` the updater counts a stdin that
  // is not a pipe as unattended and refuses to wait.
  const r = run(evosci, updateArgs(opts.version), {
    cwd: opts.cwd,
    env: opts.env,
    onStdoutLine: (l) => {
      const before = reader.view.waiting;
      const terminal = reader.terminal;
      if (!reader.push(l)) return opts.log.info(`update: ${l}`);
      const v = reader.view;
      if (v.waiting && !before)
        opts.log.info(
          `update waits for ${v.waiting
            .map((b) => `${b.name} (${b.pid})`)
            .join(", ")}`
        );
      if (reader.terminal && reader.terminal !== terminal)
        opts.log.info(
          `update: ${reader.terminal.status}${
            reader.terminal.code ? ` ${reader.terminal.code}` : ""
          }${reader.terminal.message ? `: ${reader.terminal.message}` : ""}`
        );
      if (cancelRequested && v.waiting) cancelNow();
      opts.onUpdate(v);
    },
    onStderrLine: (l) => opts.log.info(`update stderr: ${l}`),
  });
  return {
    done: r.closed.then((exit) => {
      r.closeStdin();
      const outcome = reader.outcome(exit);
      if (outcome.kind === "no_terminal_line")
        opts.log.warn(
          `update ended without its terminal line (exit ${exit.code}${
            exit.signal ? `, signal ${exit.signal}` : ""
          })`
        );
      return { outcome, view: reader.view };
    }),
    cancelWhenWaiting: () => {
      cancelRequested = true;
      return cancelNow();
    },
    cancelNow,
    waiting: () => reader.view.waiting !== null,
  };
}
