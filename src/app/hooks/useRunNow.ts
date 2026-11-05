"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAutoSkills } from "@/app/hooks/useAutoSkills";
import { isRelayRefusal, postRelay } from "@/lib/autoskillsRelay";
import {
  autoSkillsReadOnlyReason,
  labelFor,
  projectLabels,
  type DraftList,
  type DraftStatus,
} from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
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
const END_STATES = new Set(["success", "error", "timeout", "interrupted"]);

type Drafts = Pick<DraftList, "drafts">;

/** The project's drafts by id, with their status. */
function snapshotOf(list: Drafts, key: string): Map<string, DraftStatus> {
  return new Map(
    list.drafts
      .filter((d) => d.workspace_dir === key)
      .map((d) => [d.proposal_id, d.status])
  );
}

/** What a run added to the project: drafts pending now that weren't, and
 *  the ones auto mode approved (at submission) that weren't approved. */
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
  const auto = useAutoSkills();
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());

  const clientRef = useRef(client);
  clientRef.current = client;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const listRef = useRef(auto.status === "ready" ? auto.list : null);
  listRef.current = auto.status === "ready" ? auto.list : null;
  const refreshRef = useRef(auto.refresh);
  refreshRef.current = auto.refresh;

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
      new Promise<{ status: string }>((resolve, reject) => {
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

  /** The drafts read again, or undefined when the read fails, takes longer
   *  than `ms`, or the hook is cleaned up first. */
  const rereadWithin = useCallback(
    (ms: number) =>
      new Promise<unknown>((resolve) => {
        void sleep(ms).then(() => resolve(undefined));
        try {
          Promise.resolve(refreshRef.current()).then(resolve, () =>
            resolve(undefined)
          );
        } catch {
          resolve(undefined);
        }
      }),
    [sleep]
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
      // Only a list that was read can say what is new afterwards.
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
        // one, and it is followed like one started here, counted from now.
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
          toast.error(startFailure(code, label));
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
        const list = await rereadWithin(REREAD_WAIT_MS);
        if (cancelled()) return;
        const drafts = (list as { drafts?: unknown } | null | undefined)
          ?.drafts;
        toast.success(
          finishedText(
            label,
            before !== null && Array.isArray(drafts)
              ? addedSince(before, list as Drafts, key)
              : null
          )
        );
      } finally {
        // Only the run that holds the key may release it.
        if (activeRef.current.get(key) === token) {
          activeRef.current.delete(key);
          if (mountedRef.current) setRunning(new Set(activeRef.current.keys()));
        }
      }
    },
    [sleep, getRun, rereadInBackground, rereadWithin]
  );

  return { running, run };
}

function startFailure(code: string, label: string): string {
  if (code === "autoskills_off") {
    return "AutoSkills is off. Turn it on in Settings first.";
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
