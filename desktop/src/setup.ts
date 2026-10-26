// `EvoSci setup --json --skip webui` (C04, How > Setup): the stage list from
// `--manifest`, each stage's progress and result from its JSON lines, and the
// record of the core version that was last set up. The app bundles its own
// UI, so the `webui` stage is skipped. A failed stage does not stop the later
// ones; the exit code is 1 when any failed, and the version counts as set up
// only after an exit 0, so the next launch runs setup again.
import { readFileSync, writeFileSync } from "node:fs";
import { parseJsonLine, parseStageEvent, type StageEvent } from "./lines";
import { killTree, run, type ExitInfo, type Logger } from "./proc";

/** The stages the app never runs (the bundled UI replaces `webui`). */
export const SKIPPED_STAGES = ["webui"] as const;

export type StageState = "pending" | "running" | "done" | "skipped" | "error";

export interface Stage {
  id: string;
  title: string;
  state: StageState;
  /** 0..1 while running, when the stage reports it. */
  progress?: number;
  message?: string;
  /** The error code of a failed stage. */
  code?: string;
}

/** The stages of `EvoSci setup --manifest`, without the ones the app skips
 *  (the manifest lists every stage whatever `--skip` says). Null when the
 *  output is not a manifest. */
export function parseManifest(stdout: string[]): Stage[] | null {
  for (const line of stdout) {
    const v = parseJsonLine(line);
    if (!v || !Array.isArray(v.stages)) continue;
    const stages: Stage[] = [];
    for (const s of v.stages as unknown[]) {
      const id = (s as { id?: unknown })?.id;
      const title = (s as { title?: unknown })?.title;
      if (typeof id !== "string" || !id) return null;
      if ((SKIPPED_STAGES as readonly string[]).includes(id)) continue;
      stages.push({
        id,
        title: typeof title === "string" && title ? title : id,
        state: "pending",
      });
    }
    return stages;
  }
  return null;
}

/** The arguments of the setup run; `--cn` for mainland China mirrors. */
export const setupArgs = (cn: boolean) => [
  "setup",
  "--json",
  ...SKIPPED_STAGES.flatMap((s) => ["--skip", s]),
  ...(cn ? ["--cn"] : []),
];

/** The stage list after one event; a stage the manifest did not list is
 *  added at the end, and the skipped `webui` stage is left out. */
export function applyStageEvent(stages: Stage[], e: StageEvent): Stage[] {
  if ((SKIPPED_STAGES as readonly string[]).includes(e.stage)) return stages;
  const known = stages.some((s) => s.id === e.stage);
  const list = known
    ? stages
    : [...stages, { id: e.stage, title: e.stage, state: "pending" as const }];
  return list.map((s) =>
    s.id !== e.stage
      ? s
      : {
          ...s,
          state: e.status,
          progress: e.status === "running" ? e.progress : undefined,
          message:
            e.message ?? (e.status === "running" ? s.message : undefined),
          code: e.status === "error" ? e.code : undefined,
        }
  );
}

/** The stages that ended in `error`. */
export const failedStages = (stages: Stage[]) =>
  stages.filter((s) => s.state === "error");

export interface SetupRun {
  /** Ends with the exit and both output streams closed. */
  done: Promise<{ exit: ExitInfo; stages: Stage[] }>;
  /** Stops setup and what it started (closing the app, D14). */
  cancel(): Promise<void>;
}

/** Runs setup; `onUpdate` gets the stage list after every stage event. */
export function runSetup(
  evosci: string,
  opts: {
    cn: boolean;
    stages: Stage[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: Logger;
    onUpdate: (stages: Stage[]) => void;
    platform?: NodeJS.Platform;
  }
): SetupRun {
  let stages = opts.stages;
  const r = run(evosci, setupArgs(opts.cn), {
    cwd: opts.cwd,
    env: opts.env,
    group: true,
    onStdoutLine: (l) => {
      const e = parseStageEvent(l);
      if (!e) return opts.log.info(`setup: ${l}`);
      if (e.status !== "running")
        opts.log.info(
          `setup ${e.stage}: ${e.status}${e.code ? ` ${e.code}` : ""}${
            e.message ? `: ${e.message}` : ""
          }`
        );
      stages = applyStageEvent(stages, e);
      opts.onUpdate(stages);
    },
    onStderrLine: (l) => opts.log.info(`setup stderr: ${l}`),
  });
  r.closeStdin();
  return {
    done: r.closed.then((exit) => ({ exit, stages })),
    cancel: async () => {
      if (r.child.pid)
        await killTree(r.child.pid, opts.log, opts.platform, true);
    },
  };
}

/** The core version whose setup last exited 0, kept in `userData`. */
export function readSetupRecord(file: string): string | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as {
      coreVersion?: unknown;
    };
    return typeof v.coreVersion === "string" ? v.coreVersion : null;
  } catch {
    return null;
  }
}

/** Records a setup that exited 0 for this core version. */
export function writeSetupRecord(file: string, coreVersion: string): void {
  writeFileSync(
    file,
    JSON.stringify({ coreVersion, at: new Date().toISOString() }) + "\n"
  );
}

/** Setup runs on the first launch and whenever the core version changed
 *  since the last setup that exited 0. */
export const setupNeeded = (recorded: string | null, coreVersion: string) =>
  recorded !== coreVersion;
