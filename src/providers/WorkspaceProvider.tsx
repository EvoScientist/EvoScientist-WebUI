"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Client } from "@langchain/langgraph-sdk";

import { useClient } from "@/providers/ClientProvider";
import { retryWithBackoff } from "@/lib/retry";
import {
  CHAT_GRAPH_ID,
  SCHEDULER_GRAPH_ID,
  ensureWorkspaceAssistant,
  fetchServedWorkspace,
} from "@/lib/workspaceAssistant";
import type { LocalFolder, WorkspaceState } from "@/lib/workspaceSession";

export interface WorkspaceContextValue {
  /** The last folder answer the backend gave. */
  workspace: WorkspaceState;
  /** True while the folder is being read again; nothing runs meanwhile. */
  refreshing: boolean;
  /** The last failure while reading the folder, while it is retried. */
  error: string | null;
  /**
   * Whether a run may start now. Closed the moment a read starts; opened
   * only after the render that carries its answer, so a caller that sees it
   * open also holds the assistant IDs of that answer.
   */
  isReady: () => boolean;
  /** Read the folder again; resolves with the answer it publishes. */
  refresh: () => Promise<WorkspaceState>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null
);

const MAX_RETRY_MS = 10_000;

/** Graphs the WebUI runs. The chat graph must exist; a backend without one
 *  of the others leaves that surface read-only. */
const RUN_GRAPHS = [
  CHAT_GRAPH_ID,
  SCHEDULER_GRAPH_ID,
  "writing-agent",
  "data-analysis-agent",
  "expert-container-async",
];

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

async function fetchLocalFolder(
  key: string,
  signal: AbortSignal
): Promise<LocalFolder | null> {
  const res = await fetch(
    `/api/workspace/local?${new URLSearchParams({ key })}`,
    { cache: "no-store", signal }
  );
  // 404: this machine has no workspace of its own. Other failures retry.
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(`Local folder check failed (HTTP ${res.status}).`);
  return (await res.json()) as LocalFolder;
}

/**
 * Read the served folder and ensure the folder's assistants. A graph the
 * backend doesn't have (404) is absent for good; any other failure throws,
 * so the whole read is retried.
 */
async function readWorkspace(
  client: Client,
  deploymentUrl: string,
  apiKey: string,
  signal: AbortSignal
): Promise<WorkspaceState> {
  const served = await fetchServedWorkspace(deploymentUrl, apiKey, signal);
  if (!served) return { status: "legacy" };
  const created = await Promise.allSettled(
    RUN_GRAPHS.map((graphId) =>
      ensureWorkspaceAssistant(client, graphId, served.key)
    )
  );
  const graphs = new Set<string>();
  created.forEach((result, i) => {
    if (result.status === "fulfilled") graphs.add(RUN_GRAPHS[i]);
    else if (httpStatus(result.reason) !== 404) throw result.reason;
  });
  if (!graphs.has(CHAT_GRAPH_ID)) {
    throw new Error(`The backend has no ${CHAT_GRAPH_ID} graph.`);
  }
  return {
    status: "ready",
    key: served.key,
    runDir: served.runDir,
    local: await fetchLocalFolder(served.key, signal),
    graphs,
  };
}

/**
 * The backend's folder for the WebUI. Mount it once per backend
 * (`key={deploymentUrl}`): its state belongs to the client it was made with.
 */
export function WorkspaceProvider({
  children,
  deploymentUrl,
  apiKey,
}: {
  children: ReactNode;
  deploymentUrl: string;
  apiKey: string;
}) {
  const client = useClient();
  const [state, setState] = useState<{
    workspace: WorkspaceState;
    refreshing: boolean;
    error: string | null;
  }>({ workspace: { status: "pending" }, refreshing: true, error: null });

  const gateRef = useRef(false);
  // One read at a time; a request during it reads once more afterwards, so
  // the published answer is never older than the latest request.
  const runningRef = useRef<Promise<WorkspaceState> | null>(null);
  const againRef = useRef(false);
  const controllerRef = useRef(new AbortController());
  useEffect(() => {
    const controller = controllerRef.current;
    return () => controller.abort();
  }, []);

  const refresh = useCallback((): Promise<WorkspaceState> => {
    gateRef.current = false;
    setState((prev) =>
      prev.refreshing ? prev : { ...prev, refreshing: true }
    );
    if (runningRef.current) {
      againRef.current = true;
      return runningRef.current;
    }
    const signal = controllerRef.current.signal;
    const run = (async () => {
      let answer: WorkspaceState | null = null;
      do {
        againRef.current = false;
        answer = await retryWithBackoff(
          () => readWorkspace(client, deploymentUrl, apiKey, signal),
          signal,
          MAX_RETRY_MS,
          (error) =>
            setState((prev) => ({
              ...prev,
              error: error instanceof Error ? error.message : String(error),
            }))
        );
      } while (answer && againRef.current);
      if (!answer) return { status: "pending" } as WorkspaceState; // unmounted
      setState({ workspace: answer, refreshing: false, error: null });
      return answer;
    })().finally(() => {
      runningRef.current = null;
    });
    runningRef.current = run;
    return run;
  }, [client, deploymentUrl, apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the gate only once the answer has rendered (see `isReady`).
  useLayoutEffect(() => {
    gateRef.current = state.workspace.status !== "pending" && !state.refreshing;
  }, [state.workspace, state.refreshing]);

  const isReady = useCallback(() => gateRef.current, []);

  const value = useMemo(
    () => ({
      workspace: state.workspace,
      refreshing: state.refreshing,
      error: state.error,
      isReady,
      refresh,
    }),
    [state, isReady, refresh]
  );
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
