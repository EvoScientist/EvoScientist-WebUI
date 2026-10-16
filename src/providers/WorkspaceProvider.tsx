"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Assistant, Client } from "@langchain/langgraph-sdk";

import { useClient } from "@/providers/ClientProvider";
import { retryWithBackoff } from "@/lib/retry";
import {
  CHAT_GRAPH_ID,
  ensureWorkspaceAssistant,
  fetchServedWorkspace,
} from "@/lib/workspaceAssistant";

/** Whether this machine's workspace is the backend's folder, from
 *  `GET /api/workspace/local`. */
export interface LocalFolder {
  dir: string;
  sameFolder: boolean;
}

export type WorkspaceState =
  /** Not known yet: nothing runs until it is. */
  | { status: "pending" }
  /** A core without `GET /api/workspace`: graphs are addressed as before,
   *  with no folder stamping, filtering or folder-based read-only. */
  | { status: "legacy" }
  | {
      status: "ready";
      /** The served folder, as the core writes it into thread metadata. */
      key: string;
      /** Set when a `--mode=run` CLI session holds the backend. */
      runDir: string | null;
      /** Null when this machine has no workspace of its own. */
      local: LocalFolder | null;
    };

/**
 * Whether the WebUI's own file routes reach the backend's folder: they read
 * and write this machine's disk at the sidecar's folder. A backend without
 * the workspace route keeps today's behaviour.
 */
export function localFilesAvailable(workspace: WorkspaceState): boolean {
  if (workspace.status === "legacy") return true;
  return workspace.status === "ready" && workspace.local?.sameFolder === true;
}

export interface WorkspaceContextValue {
  workspace: WorkspaceState;
  /** True from the moment a refresh starts until its answer is in. */
  refreshing: boolean;
  /**
   * Whether a run may start now: the folder is known and not being read
   * again. Reads the latest state, for a check at the moment of sending.
   */
  isReady: () => boolean;
  /** `graphId`'s assistant for the served folder; on a legacy backend, the
   *  graph's system assistant. Rejects while the workspace is pending. */
  assistantFor: (graphId: string) => Promise<Assistant>;
  /** The chat graph's assistant for the current folder answer. */
  chat: ResolvedAssistant;
  /** Read the folder again; resolves with the answer (a newer refresh's
   *  when one takes over). Runs are blocked until it is in, and every
   *  assistant is ensured again for it. */
  refresh: () => Promise<WorkspaceState>;
}

/** An assistant being resolved: null until it is, with the last error while
 *  it keeps being retried. */
export interface ResolvedAssistant {
  assistant: Assistant | null;
  error: string | null;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null
);

const MAX_RETRY_MS = 10_000;
const MAX_ASSISTANT_RETRY_MS = 30_000;

/** The graph's system assistant, as the WebUI picked it before workspace
 *  assistants. */
async function systemAssistant(
  client: Client,
  graphId: string
): Promise<Assistant> {
  const assistants = await client.assistants.search({ graphId, limit: 100 });
  const found =
    assistants.find((a) => a.metadata?.["created_by"] === "system") ??
    assistants[0];
  if (!found) throw new Error(`No assistant found for ${graphId}.`);
  return found;
}

async function fetchLocalFolder(
  key: string,
  signal: AbortSignal
): Promise<LocalFolder | null> {
  try {
    const res = await fetch(
      `/api/workspace/local?${new URLSearchParams({ key })}`,
      { cache: "no-store", signal }
    );
    if (!res.ok) return null;
    return (await res.json()) as LocalFolder;
  } catch {
    return null;
  }
}

async function resolveOnce(
  deploymentUrl: string,
  apiKey: string,
  signal: AbortSignal
): Promise<WorkspaceState> {
  const served = await fetchServedWorkspace(deploymentUrl, apiKey, signal);
  if (!served) return { status: "legacy" };
  return {
    status: "ready",
    key: served.key,
    runDir: served.runDir,
    local: await fetchLocalFolder(served.key, signal),
  };
}

/**
 * `graphId`'s assistant for `workspace`, retried with backoff while it fails
 * (a backend that is down, or a graph it doesn't have); `error` names the
 * last failure meanwhile. A result belongs to the folder answer it was
 * resolved for: once `workspace` changes it reads as null, in the same
 * render, until the new one is in. Null `graphId` resolves nothing.
 */
function useResolvedAssistant(
  workspace: WorkspaceState,
  assistantFor: (graphId: string) => Promise<Assistant>,
  graphId: string | null
): ResolvedAssistant {
  const [resolved, setResolved] = useState<{
    workspace: WorkspaceState | null;
    graphId: string | null;
    assistant: Assistant | null;
    error: string | null;
  }>({ workspace: null, graphId: null, assistant: null, error: null });
  useEffect(() => {
    if (!graphId || workspace.status === "pending") return;
    const controller = new AbortController();
    void retryWithBackoff(
      () => assistantFor(graphId),
      controller.signal,
      MAX_ASSISTANT_RETRY_MS,
      (error) =>
        setResolved({
          workspace,
          graphId,
          assistant: null,
          error: error instanceof Error ? error.message : String(error),
        })
    ).then((assistant) => {
      if (assistant && !controller.signal.aborted) {
        setResolved({ workspace, graphId, assistant, error: null });
      }
    });
    return () => controller.abort();
  }, [workspace, assistantFor, graphId]);
  const current =
    resolved.workspace === workspace && resolved.graphId === graphId;
  const assistant = current ? resolved.assistant : null;
  const error = current ? resolved.error : null;
  return useMemo(() => ({ assistant, error }), [assistant, error]);
}

const PENDING: WorkspaceState = { status: "pending" };

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
  // The state belongs to the client it was resolved with: on a switch to
  // another backend it reads as pending in the same render, so nothing
  // creates an assistant for the old folder on the new backend.
  const [state, setState] = useState<{
    client: Client;
    workspace: WorkspaceState;
    refreshing: boolean;
  }>({ client, workspace: PENDING, refreshing: false });
  const own = state.client === client;
  const workspace = own ? state.workspace : PENDING;
  const refreshing = own && state.refreshing;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  // Set the moment a refresh starts, so a send in the same tick is blocked
  // before the state that says so has rendered.
  const refreshingRef = useRef(false);
  // One ensure per graph and folder answer.
  const assistants = useRef(new Map<string, Promise<Assistant>>());
  const controllerRef = useRef<AbortController | null>(null);
  const latestRefreshRef = useRef<Promise<WorkspaceState> | null>(null);

  const refresh = useCallback((): Promise<WorkspaceState> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    refreshingRef.current = true;
    setState((prev) =>
      prev.client === client ? { ...prev, refreshing: true } : prev
    );
    const run: Promise<WorkspaceState> = (async () => {
      const next = await retryWithBackoff(
        () => resolveOnce(deploymentUrl, apiKey, controller.signal),
        controller.signal,
        MAX_RETRY_MS
      );
      // A newer refresh took over: its answer is the backend's.
      if (controllerRef.current !== controller) {
        return latestRefreshRef.current ?? workspaceRef.current;
      }
      if (!next) return workspaceRef.current; // unmounted
      // Ensure every assistant again: the backend may have lost them even
      // when it serves the same folder (a fresh store after a restart).
      assistants.current.clear();
      workspaceRef.current = next;
      refreshingRef.current = false;
      setState({ client, workspace: next, refreshing: false });
      return next;
    })();
    latestRefreshRef.current = run;
    return run;
  }, [deploymentUrl, apiKey, client]);

  useEffect(() => {
    assistants.current.clear();
    void refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  const isReady = useCallback(
    () => workspaceRef.current.status !== "pending" && !refreshingRef.current,
    []
  );

  const assistantFor = useCallback(
    (graphId: string): Promise<Assistant> => {
      const current = workspaceRef.current;
      if (current.status === "pending") {
        return Promise.reject(new Error("The workspace is not known yet."));
      }
      const cacheKey =
        current.status === "ready" ? `${graphId}\n${current.key}` : graphId;
      let pending = assistants.current.get(cacheKey);
      if (!pending) {
        const created =
          current.status === "ready"
            ? ensureWorkspaceAssistant(client, graphId, current.key)
            : systemAssistant(client, graphId);
        pending = created;
        assistants.current.set(cacheKey, created);
        // A failed ensure is retried by the next caller, unless a refresh has
        // already put a newer one in its place.
        created.catch(() => {
          if (assistants.current.get(cacheKey) === created) {
            assistants.current.delete(cacheKey);
          }
        });
      }
      return pending;
    },
    [client]
  );

  const chat = useResolvedAssistant(workspace, assistantFor, CHAT_GRAPH_ID);

  const value = useMemo(
    () => ({ workspace, refreshing, isReady, assistantFor, chat, refresh }),
    [workspace, refreshing, isReady, assistantFor, chat, refresh]
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

/** `graphId`'s assistant for the backend's folder, retried while it fails;
 *  null `graphId` resolves nothing. */
export function useGraphAssistant(graphId: string | null): ResolvedAssistant {
  const { workspace, assistantFor } = useWorkspace();
  return useResolvedAssistant(workspace, assistantFor, graphId);
}
