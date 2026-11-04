"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAutoSkills } from "@/app/hooks/useAutoSkills";
import { isRelayRefusal, postRelay } from "@/lib/autoskillsRelay";
import {
  autoSkillsReadOnlyReason,
  labelFor,
  projectLabels,
} from "@/lib/autoskills";
import type { Project } from "@/lib/projects";
import { useClient } from "@/providers/ClientProvider";

export const RUN_POLL_MS = 3_000;

const MAX_FAILED_POLLS = 3;
const END_STATES = new Set(["success", "error", "timeout", "interrupted"]);

function pendingIds(
  list: {
    drafts: readonly {
      proposal_id: string;
      status: string;
      workspace_dir: string;
    }[];
  },
  key: string
): Set<string> {
  return new Set(
    list.drafts
      .filter((d) => d.status === "pending" && d.workspace_dir === key)
      .map((d) => d.proposal_id)
  );
}

/** Start AutoSkills in a project, wait for the run and say how it went. */
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

  const activeRef = useRef(new Set<string>());
  // Bumped on every cleanup: a run that started before it is cancelled.
  const epochRef = useRef(0);
  const mountedRef = useRef(false);
  const sleepersRef = useRef(
    new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>()
  );

  useEffect(() => {
    mountedRef.current = true;
    const sleepers = sleepersRef.current;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      for (const s of sleepers) {
        clearTimeout(s.timer);
        s.resolve();
      }
      sleepers.clear();
    };
  }, []);

  const sleep = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        const sleeper = {
          timer: setTimeout(() => {
            sleepersRef.current.delete(sleeper);
            resolve();
          }, ms),
          resolve,
        };
        sleepersRef.current.add(sleeper);
      }),
    []
  );

  const run = useCallback(
    async (key: string): Promise<void> => {
      if (activeRef.current.has(key)) return;
      activeRef.current.add(key);
      setRunning(new Set(activeRef.current));
      const epoch = epochRef.current;
      const cancelled = () => epochRef.current !== epoch;
      const label = labelFor(key, projectLabels(projectsRef.current));
      // Only a list that was read can say what is new afterwards.
      const before = listRef.current ? pendingIds(listRef.current, key) : null;

      /** true: success; false: any other end; null: cancelled. */
      async function poll(
        threadId: string,
        runId: string
      ): Promise<boolean | null> {
        let failed = 0;
        for (;;) {
          await sleep(RUN_POLL_MS);
          if (cancelled()) return null;
          try {
            const r = await clientRef.current.runs.get(threadId, runId);
            if (cancelled()) return null;
            failed = 0;
            if (END_STATES.has(r.status)) return r.status === "success";
          } catch {
            if (cancelled()) return null;
            if (++failed >= MAX_FAILED_POLLS) return false;
          }
        }
      }

      try {
        const start = await postRelay({ action: "run", workspace_dir: key });
        if (cancelled()) return;
        const data = start === "network" ? {} : start.data;
        if (
          start === "network" ||
          !start.ok ||
          typeof data.thread_id !== "string" ||
          typeof data.run_id !== "string"
        ) {
          // The specific sentences are for refused answers; a 2xx without
          // ids is always the generic one.
          const code =
            start !== "network" && !start.ok && typeof data.error === "string"
              ? data.error
              : "";
          toast.error(startFailure(code, label));
          return;
        }
        const finished = await poll(data.thread_id, data.run_id);
        if (finished === null) return;
        if (!finished) {
          toast.error(
            `AutoSkills didn't finish in ${label}. Try Run now again later.`
          );
          return;
        }
        let list: unknown;
        try {
          list = await refreshRef.current();
        } catch {
          list = undefined;
        }
        if (cancelled()) return;
        const drafts = (list as { drafts?: unknown } | null | undefined)
          ?.drafts;
        if (before === null || !Array.isArray(drafts)) {
          toast.success(`AutoSkills finished in ${label}.`);
          return;
        }
        const n = [
          ...pendingIds(list as Parameters<typeof pendingIds>[0], key),
        ].filter((id) => !before.has(id)).length;
        toast.success(
          n === 0
            ? `AutoSkills finished in ${label}: no new patterns this time.`
            : n === 1
            ? `AutoSkills finished in ${label}: 1 new draft.`
            : `AutoSkills finished in ${label}: ${n} new drafts.`
        );
      } finally {
        activeRef.current.delete(key);
        if (mountedRef.current) setRunning(new Set(activeRef.current));
      }
    },
    [sleep]
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
