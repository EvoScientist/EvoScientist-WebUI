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
import { getHttpStatus } from "@/lib/streamError";
import { RUN_GRAPHS } from "@/lib/threadBinding";
import {
  CHAT_GRAPH_ID,
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

async function fetchLocalFolder(
  key: string,
  signal: AbortSignal
): Promise<LocalFolder | null> {
  const res = await fetch(
    `/api/workspace/local?${new URLSearchParams({ key })}`,
    { cache: "no-store", signal }
  );
  // 404: this machine has no workspace of its own.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Local folder check failed (HTTP ${res.status}).`);
  }
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
  // The chat graph must exist; a backend without one of the others leaves
  // that surface read-only.
  const runGraphs = [...RUN_GRAPHS];
  // The local check only decides the file views: if it fails, they are off,
  // and the chat is not held up.
  const local = fetchLocalFolder(served.key, signal).catch(() => null);
  const created = await Promise.allSettled(
    runGraphs.map((graphId) =>
      ensureWorkspaceAssistant(client, graphId, served.key)
    )
  );
  const graphs = new Set<string>();
  created.forEach((result, i) => {
    if (result.status === "fulfilled") graphs.add(runGraphs[i]);
    else if (getHttpStatus(result.reason) !== 404) throw result.reason;
  });
  if (!graphs.has(CHAT_GRAPH_ID)) {
    throw new Error(`The backend has no ${CHAT_GRAPH_ID} graph.`);
  }
  return {
    status: "ready",
    key: served.key,
    runDir: served.runDir,
    local: await local,
    graphs,
  };
}

/**
 * The backend's folder for the WebUI. On another backend it starts over: the
 * last backend's answer is dropped in the same render, so nothing renders or
 * runs on it while the new one is read.
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
  const backend = `${deploymentUrl}\n${apiKey}`;
  const [state, setState] = useState<{
    backend: string;
    workspace: WorkspaceState;
    refreshing: boolean;
    error: string | null;
  }>({
    backend,
    workspace: { status: "pending" },
    refreshing: true,
    error: null,
  });
  if (state.backend !== backend) {
    setState({
      backend,
      workspace: { status: "pending" },
      refreshing: true,
      error: null,
    });
  }

  const gateRef = useRef(false);
  // One read at a time; a request during it reads once more afterwards, so
  // the published answer is never older than the latest request.
  const runningRef = useRef<{ promise: Promise<WorkspaceState> } | null>(null);
  const againRef = useRef(false);
  // Made per mount and per backend: the last one's read is aborted, as is
  // the first mount's under React's development double mount.
  const controllerRef = useRef<{
    backend: string;
    controller: AbortController;
  } | null>(null);

  const refresh = useCallback((): Promise<WorkspaceState> => {
    // A `refresh` kept from before a switch to another backend (a request
    // that failed late) reads nothing: the current backend's is in charge.
    const current = controllerRef.current;
    if (current?.backend !== backend) {
      return Promise.resolve({ status: "pending" });
    }
    const { controller } = current;
    gateRef.current = false;
    setState((prev) =>
      prev.refreshing ? prev : { ...prev, refreshing: true }
    );
    if (runningRef.current) {
      againRef.current = true;
      return runningRef.current.promise;
    }
    const run: { promise: Promise<WorkspaceState> } = {
      promise: Promise.resolve({ status: "pending" }),
    };
    run.promise = (async () => {
      let answer: WorkspaceState | null = null;
      do {
        againRef.current = false;
        answer = await retryWithBackoff(
          () => readWorkspace(client, deploymentUrl, apiKey, controller.signal),
          controller.signal,
          MAX_RETRY_MS,
          (error) =>
            setState((prev) => ({
              ...prev,
              error: error instanceof Error ? error.message : String(error),
            }))
        );
      } while (answer && !controller.signal.aborted && againRef.current);
      // Done before publishing, in the same step: a request from here on
      // starts a new read rather than joining this finished one.
      if (runningRef.current === run) runningRef.current = null;
      // Unmounted, or moved to another backend while `assistants.create`,
      // which takes no signal, was in flight: the answer is the last one's.
      if (!answer || controller.signal.aborted) {
        return { status: "pending" } as WorkspaceState;
      }
      const published = answer;
      setState((prev) => ({
        ...prev,
        workspace: published,
        refreshing: false,
        error: null,
      }));
      return published;
    })();
    runningRef.current = run;
    return run.promise;
  }, [client, deploymentUrl, apiKey, backend]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = { backend, controller };
    runningRef.current = null;
    againRef.current = false;
    void refresh();
    return () => {
      controller.abort();
      if (controllerRef.current?.controller === controller) {
        controllerRef.current = null;
      }
    };
  }, [refresh, backend]);

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
