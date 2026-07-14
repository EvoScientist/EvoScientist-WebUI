"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { makeClient } from "@/app/hooks/useScheduledTasks";
import {
  buildRunRecord,
  isActiveStatus,
  runMatchesTask,
  type ScheduledRunRecord,
} from "@/lib/scheduledRuns";

const POLL_INTERVAL_MS = 3_000;
const SEARCH_LIMIT = 50;
const MAX_RUNS = 20;

const SCHEDULER_GRAPH_ID = "scheduler";

interface SchedulerThread {
  thread_id: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: unknown;
}

interface UseScheduledTaskRunsResult {
  runs: ScheduledRunRecord[];
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

export function useScheduledTaskRuns(
  task: { cron_id: string; prompt: string } | null
): UseScheduledTaskRunsResult {
  const [runs, setRuns] = useState<ScheduledRunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const mountedRef = useRef(true);
  const claimsRef = useRef(new Map<string, ScheduledRunRecord | false>());
  const cronId = task?.cron_id ?? null;
  const prompt = task?.prompt ?? "";

  useEffect(() => {
    claimsRef.current = new Map();
  }, [cronId]);

  const refresh = useCallback(async () => {
    if (!cronId) {
      setRuns([]);
      setLoaded(true);
      return;
    }
    const client = makeClient();
    if (!client) {
      setRuns([]);
      setLoaded(true);
      return;
    }
    const reqId = ++reqRef.current;
    const claims = claimsRef.current;
    try {
      const threads = (await client.threads.search({
        metadata: { graph_id: SCHEDULER_GRAPH_ID },
        limit: SEARCH_LIMIT,
      })) as SchedulerThread[];
      const records = await Promise.all(
        threads.map(async (thread): Promise<ScheduledRunRecord | null> => {
          const cached = claims.get(thread.thread_id);
          if (cached === false) return null;
          if (
            cached &&
            !isActiveStatus(cached.status) &&
            cached.thread_updated_at === (thread.updated_at ?? null)
          ) {
            return cached;
          }
          try {
            const threadRuns = (await client.runs.list(thread.thread_id, {
              limit: 1,
            })) as unknown[];
            const run = threadRuns[0];
            if (!run) return null;
            if (
              !runMatchesTask(run, thread.metadata, { cron_id: cronId, prompt })
            ) {
              claims.set(thread.thread_id, false);
              return null;
            }
            const record = buildRunRecord(run, thread);
            claims.set(thread.thread_id, record);
            return record;
          } catch {
            return cached || null;
          }
        })
      );
      if (reqId !== reqRef.current || !mountedRef.current) return;
      const next = records
        .filter((r): r is ScheduledRunRecord => Boolean(r))
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
        .slice(0, MAX_RUNS);
      setRuns(next);
      setError(null);
    } catch {
      if (reqId === reqRef.current && mountedRef.current) {
        setError("Couldn't load task runs.");
      }
    } finally {
      if (reqId === reqRef.current && mountedRef.current) setLoaded(true);
    }
  }, [cronId, prompt]);

  useEffect(() => {
    mountedRef.current = true;
    setLoaded(false);
    refresh();
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  return { runs, loaded, error, refresh };
}
