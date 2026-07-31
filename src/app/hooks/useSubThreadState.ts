"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useClient } from "@/providers/ClientProvider";
import type { TodoItem } from "@/app/types/types";

/** Async sub-thread state shape as returned by `client.threads.getState`.
 *  We only care about `values.messages` (for step rendering + metrics) and
 *  `values.todos` (for the phased task-list card); everything else is
 *  passed through as unknown so callers can widen locally if they need to. */
export interface SubThreadState {
  values: {
    messages: unknown[];
    todos: TodoItem[];
    [key: string]: unknown;
  };
}

interface UseSubThreadStateResult {
  state: SubThreadState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** True when the sub-thread's underlying run is gone (404 on getState).
   *  PersonaFocusView surfaces an explanatory banner in this case instead of
   *  a raw "Couldn't load…" error. */
  expired: boolean;
}

/** The SDK throws HTTPError with a numeric `status` on non-2xx responses.
 *  404 on getState means the sub-thread no longer exists (backend restarts
 *  wipe sub-agent thread state; only main-graph threads are restored). */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 404
  );
}

const DEFAULT_INTERVAL_MS = 2500;

/**
 * Watch a sub-thread's persisted state. Polls `client.threads.getState` on
 * an interval (default 2.5s) while the tab is visible and `subThreadId` is
 * set. Stops polling and returns `state = null` when `subThreadId` is null.
 *
 * A monotonic request-id guard prevents a stale poll — say, one issued
 * before a subThreadId switch — from overwriting the newer thread's state.
 *
 * Live streaming (a second `useStream` per focused sub-thread) would give
 * lower latency, but a 2.5s poll is imperceptibly different for the phased
 * task-list card + sub-thread step list and avoids the socket overhead.
 * `AgentsPanel.tsx:271` already uses the same one-shot getState pattern
 * without complaints.
 */
export function useSubThreadState(
  subThreadId: string | null,
  opts?: { intervalMs?: number }
): UseSubThreadStateResult {
  const client = useClient();
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [state, setState] = useState<SubThreadState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const reqRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!subThreadId) {
      setState(null);
      setLoading(false);
      setError(null);
      setExpired(false);
      return;
    }
    const reqId = ++reqRef.current;
    try {
      const next = (await client.threads.getState(subThreadId)) as {
        values?: { messages?: unknown[]; todos?: TodoItem[] };
      };
      if (reqId !== reqRef.current || !mountedRef.current) return;
      setState({
        values: {
          messages: Array.isArray(next.values?.messages)
            ? (next.values?.messages as unknown[])
            : [],
          todos: Array.isArray(next.values?.todos)
            ? (next.values?.todos as TodoItem[])
            : [],
          ...(next.values ?? {}),
        },
      });
      setError(null);
      setExpired(false);
    } catch (err) {
      if (reqId !== reqRef.current || !mountedRef.current) return;
      if (isNotFoundError(err)) {
        // Permanent for this thread — keep whatever state we may have shown
        // before (if any) and surface an expired flag. The persona focus
        // view renders an explanatory banner rather than a raw error.
        setExpired(true);
        setError(null);
      } else {
        setError("Couldn't load this expert's state.");
      }
    } finally {
      if (reqId === reqRef.current && mountedRef.current) setLoading(false);
    }
  }, [client, subThreadId]);

  // Reset transient state on subThreadId change (before the first fetch
  // lands). Prevents flashing the previous expert's messages during a chip
  // switch.
  useEffect(() => {
    setState(null);
    setLoading(Boolean(subThreadId));
    setError(null);
    setExpired(false);
  }, [subThreadId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!subThreadId) {
      return () => {
        mountedRef.current = false;
      };
    }
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh, subThreadId, intervalMs]);

  return { state, loading, error, refresh, expired };
}
