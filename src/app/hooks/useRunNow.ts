"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAutoSkills } from "@/app/hooks/useAutoSkills";
import { useSettings } from "@/app/hooks/useSettings";
import { isRelayRefusal, postRelay } from "@/lib/autoskillsRelay";
import {
  autoSkillsReadOnlyReason,
  labelFor,
  projectLabels,
  secondOf,
  type DraftList,
  type DraftStatus,
} from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import { shadowedSource } from "@/lib/settingsForm";
import { useClient } from "@/providers/ClientProvider";

export const RUN_POLL_MS = 3_000;
/** How long one poll may take: the SDK sets no timeout, and a request that
 *  never answers would hold the run, and its ceiling, for good. A poll that
 *  takes longer counts as a failed one. */
export const RUN_GET_TIMEOUT_MS = 15_000;
/** How long a run is followed; then the page stops asking (the run goes on,
 *  and the drafts update when it finishes). */
export const RUN_CEILING_MS = 30 * 60_000;
/** How long the end of a run waits for the drafts' re-read, which has no
 *  timeout of its own, before it says so without a count. */
export const REREAD_WAIT_MS = 10_000;

const MAX_FAILED_POLLS = 3;
/** The page's readers keep the drafts fresh; this one adds no interval. */
const NO_POLL = { poll: false } as const;
const END_STATES = new Set(["success", "error", "timeout", "interrupted"]);

type Drafts = Pick<DraftList, "drafts">;
/** What a poll reads of the run: how it stands, and when it was created
 *  (LangGraph's stamp: microseconds, `+00:00`). */
type RunPoll = { status: string; created_at?: unknown };

/** The project's drafts by id, with their status. */
function snapshotOf(list: Drafts, key: string): Map<string, DraftStatus> {
  return new Map(
    list.drafts
      .filter((d) => d.workspace_dir === key)
      .map((d) => [d.proposal_id, d.status])
  );
}

/** What a run that started at `since` (its `created_at`, cut to the second
 *  as the core's stamps are) added to the project: the drafts pending now
 *  that were created at or after it, and the ones auto mode approved at or
 *  after it. By the drafts' own stamps, not by what a list read earlier
 *  held: that list can be a minute old (a cron run's drafts since would
 *  count), and one read when the page joined a run already holds what the
 *  run made before. A pending draft the run resubmitted keeps its
 *  created_at: not new. Known limit: another run in the project at the same
 *  time (a cron run) is counted too. */
function addedAfter(
  since: number,
  list: Drafts,
  key: string
): { drafts: number; installed: number } {
  const sinceThen = (stamp: string | null) => {
    const at = secondOf(stamp);
    return at !== null && at >= since;
  };
  let drafts = 0;
  let installed = 0;
  for (const d of list.drafts) {
    if (d.workspace_dir !== key) continue;
    if (d.status === "pending") {
      if (sinceThen(d.created_at)) drafts += 1;
    } else if (d.status === "approved" && d.approved_by === "auto") {
      if (sinceThen(d.approved_at)) installed += 1;
    }
  }
  return { drafts, installed };
}

/** The same without the run's start (a run whose `created_at` can't be
 *  read), against the project's drafts as a list read before held them:
 *  drafts pending now that weren't, and the ones auto mode approved (at
 *  submission) that weren't approved. */
function addedSince(
  before: ReadonlyMap<string, DraftStatus>,
  list: Drafts,
  key: string
): { drafts: number; installed: number } {
  let drafts = 0;
  let installed = 0;
  for (const d of list.drafts) {
    if (d.workspace_dir !== key) continue;
    const was = before.get(d.proposal_id);
    if (d.status === "pending" && was !== "pending") drafts += 1;
    else if (
      d.status === "approved" &&
      d.approved_by === "auto" &&
      was !== "approved"
    ) {
      installed += 1;
    }
  }
  return { drafts, installed };
}

/** The end toast; without counts (no list before or after) it says only
 *  that the run finished. */
function finishedText(
  label: string,
  added: { drafts: number; installed: number } | null
): string {
  if (added === null) return `AutoSkills finished in ${label}.`;
  const parts: string[] = [];
  if (added.drafts > 0) {
    parts.push(
      added.drafts === 1 ? "1 new draft" : `${added.drafts} new drafts`
    );
  }
  if (added.installed > 0) {
    parts.push(
      added.installed === 1
        ? "1 skill installed automatically"
        : `${added.installed} skills installed automatically`
    );
  }
  return parts.length === 0
    ? `AutoSkills finished in ${label}: no new patterns this time.`
    : `AutoSkills finished in ${label}: ${parts.join(", ")}.`;
}

/** Start AutoSkills in a project, or follow the run already going there,
 *  wait for it and say how it went. */
export function useRunNow(projects: readonly Project[]): {
  running: ReadonlySet<string>;
  run(projectKey: string): Promise<void>;
} {
  const client = useClient();
  const auto = useAutoSkills(NO_POLL);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());

  const clientRef = useRef(client);
  clientRef.current = client;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const listRef = useRef(auto.status === "ready" ? auto.list : null);
  listRef.current = auto.status === "ready" ? auto.list : null;
  const refreshRef = useRef(auto.refresh);
  refreshRef.current = auto.refresh;
  const readNowRef = useRef(auto.readNow);
  readNowRef.current = auto.readNow;
  // The settings as read now: a refusal is worded by them when it comes.
  const { payload } = useSettings();
  const settingsRef = useRef(payload);
  settingsRef.current = payload;

  // The token of the run that holds each project key.
  const activeRef = useRef(new Map<string, object>());
  // Bumped on every cleanup: a run that started before it is cancelled.
  const epochRef = useRef(0);
  const mountedRef = useRef(false);
  const sleepersRef = useRef(
    new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>()
  );

  useEffect(() => {
    mountedRef.current = true;
    // A re-run of this effect follows a cleanup that released every key.
    setRunning((prev) => (prev.size > 0 ? new Set() : prev));
    const sleepers = sleepersRef.current;
    const active = activeRef.current;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      active.clear();
      for (const s of sleepers) {
        clearTimeout(s.timer);
        s.resolve();
      }
      sleepers.clear();
    };
  }, [client]);

  /** A wait that a cleanup ends at once; `cancel` drops it unended. */
  const pause = useCallback((ms: number) => {
    let sleeper!: {
      timer: ReturnType<typeof setTimeout>;
      resolve: () => void;
    };
    const promise = new Promise<void>((resolve) => {
      sleeper = {
        timer: setTimeout(() => {
          sleepersRef.current.delete(sleeper);
          resolve();
        }, ms),
        resolve,
      };
      sleepersRef.current.add(sleeper);
    });
    const cancel = () => {
      clearTimeout(sleeper.timer);
      sleepersRef.current.delete(sleeper);
    };
    return { promise, cancel };
  }, []);

  const sleep = useCallback((ms: number) => pause(ms).promise, [pause]);

  /** One poll of the run: given up on (and aborted) after
   *  RUN_GET_TIMEOUT_MS, and at once on a cleanup. */
  const getRun = useCallback(
    (threadId: string, runId: string) =>
      new Promise<RunPoll>((resolve, reject) => {
        const controller = new AbortController();
        const limit = pause(RUN_GET_TIMEOUT_MS);
        void limit.promise.then(() => {
          controller.abort();
          reject(new Error("The run's status didn't come in time."));
        });
        try {
          clientRef.current.runs
            .get(threadId, runId, { signal: controller.signal })
            .then(
              (r) => {
                limit.cancel();
                resolve(r);
              },
              (e: unknown) => {
                limit.cancel();
                reject(e);
              }
            );
        } catch (e) {
          limit.cancel();
          reject(e);
        }
      }),
    [pause]
  );

  /** Read the drafts again without waiting for the answer; a failure is
   *  the next poll's to fix. */
  const rereadInBackground = useCallback(() => {
    try {
      void Promise.resolve(refreshRef.current()).catch(() => {});
    } catch {
      // Same.
    }
  }, []);

  /** The drafts as the backend has them now, or undefined when the read
   *  fails, takes longer than `ms` (it is aborted) or the hook is cleaned up
   *  first. Read directly: SWR's mutate answers with the last good list
   *  when a read fails, which would count nothing as new. */
  const readWithin = useCallback(
    (ms: number) =>
      new Promise<DraftList | "unsupported" | undefined>((resolve) => {
        const controller = new AbortController();
        const limit = pause(ms);
        void limit.promise.then(() => {
          controller.abort();
          resolve(undefined);
        });
        try {
          readNowRef.current(controller.signal).then(
            (answer) => {
              limit.cancel();
              resolve(answer);
            },
            () => {
              limit.cancel();
              resolve(undefined);
            }
          );
        } catch {
          limit.cancel();
          resolve(undefined);
        }
      }),
    [pause]
  );

  const run = useCallback(
    async (key: string): Promise<void> => {
      if (activeRef.current.has(key)) return;
      const token = {};
      activeRef.current.set(key, token);
      setRunning(new Set(activeRef.current.keys()));
      const epoch = epochRef.current;
      const cancelled = () => epochRef.current !== epoch;
      const label = labelFor(key, projectLabels(projectsRef.current));
      // When the run started, to the second, from the first poll that
      // answers: the end counts what the drafts say was made since.
      let startedAt: number | null = null;
      // Only for a run whose start can't be read: the project's drafts as
      // the page's list holds them now, to compare with afterwards (only a
      // list that was read can say what is new).
      const snapshot = () =>
        listRef.current ? snapshotOf(listRef.current, key) : null;
      let before = snapshot();

      /** How the run ended for this page: its own end, three failed (or
       *  timed-out) polls in a row, the ceiling, or a cleanup. */
      async function poll(
        threadId: string,
        runId: string
      ): Promise<"success" | "failed" | "ceiling" | "cancelled"> {
        const since = Date.now();
        // By the clock, before and after each poll: a slow one can cross it.
        const late = () => Date.now() - since >= RUN_CEILING_MS;
        let failed = 0;
        for (;;) {
          await sleep(RUN_POLL_MS);
          if (cancelled()) return "cancelled";
          if (late()) return "ceiling";
          try {
            const r = await getRun(threadId, runId);
            if (cancelled()) return "cancelled";
            failed = 0;
            startedAt ??= secondOf(r.created_at);
            if (END_STATES.has(r.status)) {
              return r.status === "success" ? "success" : "failed";
            }
          } catch {
            if (cancelled()) return "cancelled";
            if (++failed >= MAX_FAILED_POLLS) return "failed";
          }
          if (late()) return "ceiling";
        }
      }

      try {
        const start = await postRelay({ action: "run", workspace_dir: key });
        if (cancelled()) return;
        const data = start === "network" ? {} : start.data;
        const threadId = data.thread_id;
        const runId = data.run_id;
        const named = typeof threadId === "string" && typeof runId === "string";
        // A manual run of this project is already going (another tab, an
        // earlier page): the core names it instead of starting a second
        // one, and it is followed like one started here, counted from its
        // own start (without one, from now).
        const joined =
          start !== "network" &&
          start.status === 409 &&
          data.error === "already_running" &&
          named;
        if (start === "network" || !(start.ok || joined) || !named) {
          // The specific sentences are for refused answers; a 2xx without
          // ids is always the generic one.
          const code =
            start !== "network" && !start.ok && typeof data.error === "string"
              ? data.error
              : "";
          // Off by an environment variable: the page's Settings can't turn
          // it on (the core refuses by the value in use).
          const offByOverride =
            !!settingsRef.current &&
            shadowedSource(
              settingsRef.current,
              "memory_skill_synthesis_enabled"
            ) !== null;
          toast.error(startFailure(code, label, offByOverride));
          return;
        }
        if (joined) {
          before = snapshot();
          toast.info(`AutoSkills is already running in ${label}.`);
        }
        const end = await poll(threadId, runId);
        if (end === "cancelled") return;
        if (end === "ceiling") {
          rereadInBackground();
          toast.info(
            `AutoSkills is still running in ${label}. The drafts update when it finishes.`
          );
          return;
        }
        if (end === "failed") {
          toast.error(
            `AutoSkills didn't finish in ${label}. Try Run now again later.`
          );
          return;
        }
        const list = await readWithin(REREAD_WAIT_MS);
        if (cancelled()) return;
        let added: { drafts: number; installed: number } | null = null;
        if (typeof list === "object") {
          if (startedAt !== null) added = addedAfter(startedAt, list, key);
          else if (before !== null) added = addedSince(before, list, key);
        }
        toast.success(finishedText(label, added));
      } finally {
        // Only the run that holds the key may release it.
        if (activeRef.current.get(key) === token) {
          activeRef.current.delete(key);
          if (mountedRef.current) setRunning(new Set(activeRef.current.keys()));
        }
      }
    },
    [sleep, getRun, rereadInBackground, readWithin]
  );

  return { running, run };
}

function startFailure(
  code: string,
  label: string,
  offByOverride: boolean
): string {
  if (code === "autoskills_off") {
    return offByOverride
      ? "AutoSkills is off: an environment variable on the machine that runs EvoScientist turns it off."
      : "AutoSkills is off. Turn it on in Settings first.";
  }
  if (code === "not_served") {
    return `${label} isn't served by this backend right now.`;
  }
  if (code === "local_secret_required" || isRelayRefusal(code)) {
    return (
      autoSkillsReadOnlyReason({
        writable: false,
        reason: code === "local_secret_required" ? "secret_rejected" : code,
      }) ?? ""
    );
  }
  return `AutoSkills didn't start in ${label}. Try Run now again later.`;
}
