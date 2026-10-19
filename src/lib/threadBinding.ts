import {
  CHAT_GRAPH_ID,
  SCHEDULER_GRAPH_ID,
  folderName,
} from "@/lib/workspaceAssistant";
import type { WorkspaceState } from "@/lib/workspaceSession";

/** Graphs the main chat runs; other threads opened in it are read-only. */
export const CHAT_GRAPHS: ReadonlySet<string> = new Set([
  CHAT_GRAPH_ID,
  SCHEDULER_GRAPH_ID,
]);
/** Graphs whose threads the Agents panel sends follow-ups to. */
export const AGENT_GRAPHS: ReadonlySet<string> = new Set([
  "writing-agent",
  "data-analysis-agent",
  "expert-container-async",
  SCHEDULER_GRAPH_ID,
]);
/** Every graph the WebUI runs: their assistants are ensured per folder. */
export const RUN_GRAPHS: ReadonlySet<string> = new Set([
  ...CHAT_GRAPHS,
  ...AGENT_GRAPHS,
]);

/** The folders a thread records: its own metadata first, else its latest
 *  checkpoint's. */
export interface ThreadFolders {
  graphId: string | null;
  workspaceDir: string | null;
  runDir: string | null;
}

export type ThreadBinding =
  /** Not known yet (workspace or thread still loading): nothing runs. */
  | { kind: "pending" }
  /** Runs here. */
  | { kind: "open" }
  /** No folder recorded anywhere: runs here, and the first send stamps the
   *  current folder on it. */
  | { kind: "unbound" }
  | { kind: "readOnly"; reason: string };

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * The folders recorded for a thread. The restore rewrites thread metadata in
 * the core's key form at every server start, while old checkpoints keep older
 * spellings, so the thread's own metadata comes first; the latest checkpoint
 * covers threads other clients created since the server started.
 */
export function threadFolders(
  threadMetadata: Record<string, unknown> | null | undefined,
  checkpointMetadata: Record<string, unknown> | null | undefined
): ThreadFolders {
  // The graph comes from the thread's own metadata, as the run's assistant
  // does (the server and the SDK set it there): the two never disagree.
  const graphId = stringField(threadMetadata, "graph_id");
  const fromThread = stringField(threadMetadata, "workspace_dir");
  const source = fromThread ? threadMetadata : checkpointMetadata;
  return {
    graphId,
    workspaceDir: stringField(source, "workspace_dir"),
    runDir: stringField(source, "run_dir"),
  };
}

/**
 * Whether a thread can run on this backend.
 *
 * `folders` is null for a new chat (no thread yet) and undefined while the
 * thread is loading. `allowedGraphs` names the graphs this surface runs.
 */
export function threadBinding(
  workspace: WorkspaceState,
  folders: ThreadFolders | null | undefined,
  allowedGraphs: ReadonlySet<string>,
  /** The graph of a thread that names none; null: such a thread can't run. */
  defaultGraph: string | null = CHAT_GRAPH_ID
): ThreadBinding {
  if (workspace.status === "pending" || folders === undefined) {
    return { kind: "pending" };
  }
  const graphId = folders?.graphId ?? defaultGraph;
  if (!graphId) {
    return {
      kind: "readOnly",
      reason:
        "This conversation doesn't record its graph, so it can't be continued here.",
    };
  }
  if (!allowedGraphs.has(graphId)) {
    return {
      kind: "readOnly",
      reason: `This conversation belongs to ${graphId}, which can't be continued here.`,
    };
  }
  if (workspace.status === "legacy") return { kind: "open" };
  if (workspace.runDir && graphId !== SCHEDULER_GRAPH_ID) {
    return {
      kind: "readOnly",
      reason:
        "A CLI session in a run folder holds the backend. Continue there, or restart the backend.",
    };
  }
  if (folders === null) return { kind: "open" };
  if (folders.runDir) {
    return {
      kind: "readOnly",
      reason:
        "This conversation works in a run folder. Continue it in the CLI or the TUI.",
    };
  }
  if (!folders.workspaceDir) return { kind: "unbound" };
  if (folders.workspaceDir !== workspace.key) {
    return {
      kind: "readOnly",
      reason: `This conversation belongs to ${folderName(
        folders.workspaceDir
      )} (${folders.workspaceDir}), not the backend's folder.`,
    };
  }
  return { kind: "open" };
}

export function canRun(binding: ThreadBinding): boolean {
  return binding.kind === "open" || binding.kind === "unbound";
}
