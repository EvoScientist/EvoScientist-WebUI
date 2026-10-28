import {
  CHAT_GRAPH_ID,
  SCHEDULER_GRAPH_ID,
  folderName,
  workspaceAssistantId,
} from "@/lib/workspaceAssistant";
import { findProject, type ProjectsState } from "@/lib/projects";

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
/** The folders a thread records: its own metadata first, else its latest
 *  checkpoint's. */
export interface ThreadFolders {
  graphId: string | null;
  workspaceDir: string | null;
  runDir: string | null;
}

export type ThreadBinding =
  /** Not known yet (projects or thread still loading): nothing runs. */
  | { kind: "pending" }
  /** Runs in the project at `key`: the thread's own, or a new chat's. */
  | { kind: "open"; key: string }
  /** No folder recorded anywhere: runs in the project at `key`, and the
   *  first send stamps it on the thread. */
  | { kind: "unbound"; key: string }
  /** `folder`: the thread's folder, when it isn't a registered project. */
  | { kind: "readOnly"; reason: string; folder?: string };

/** Why nothing can start when no project can run. */
export const NO_PROJECT_REASON =
  "No project to work in: add one from the sidebar, or run EvoSci in a folder.";

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
 * Whether a thread can run on this backend, and in which project.
 *
 * `folders` is null for a new chat (no thread yet) and undefined while the
 * thread is loading. `allowedGraphs` names the graphs this surface runs.
 * `fallback` is the project a new chat, or a thread that records no folder,
 * runs in (the current project); null when there is none, and
 * `noProjectReason` says why such a chat or thread can't run.
 */
export function threadBinding(
  projects: ProjectsState,
  folders: ThreadFolders | null | undefined,
  allowedGraphs: ReadonlySet<string>,
  fallback: string | null,
  /** The graph of a thread that names none; null: such a thread can't run. */
  defaultGraph: string | null = CHAT_GRAPH_ID,
  noProjectReason: string = NO_PROJECT_REASON
): ThreadBinding {
  if (projects.status === "pending" || folders === undefined) {
    return { kind: "pending" };
  }
  if (projects.status === "unsupported") {
    return { kind: "readOnly", reason: UNSUPPORTED_CORE_REASON };
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
  if (folders === null) {
    return fallback
      ? { kind: "open", key: fallback }
      : { kind: "readOnly", reason: noProjectReason };
  }
  if (folders.runDir) {
    return {
      kind: "readOnly",
      reason:
        "This conversation works in a run folder. Continue it in the CLI or the TUI.",
    };
  }
  if (!folders.workspaceDir) {
    return fallback
      ? { kind: "unbound", key: fallback }
      : { kind: "readOnly", reason: noProjectReason };
  }
  const project = findProject(projects, folders.workspaceDir);
  const label = `${folderName(folders.workspaceDir)} (${folders.workspaceDir})`;
  if (!project) {
    return {
      kind: "readOnly",
      reason: `This conversation belongs to ${label}, which isn't a project on this backend.`,
      folder: folders.workspaceDir,
    };
  }
  if (project.missing) {
    return {
      kind: "readOnly",
      reason: `This conversation's project folder, ${label}, is missing.`,
    };
  }
  return { kind: "open", key: project.key };
}

/** Why nothing runs on a core older than one backend for every project. */
export const UNSUPPORTED_CORE_REASON =
  "This EvoScientist is too old for this WebUI: update it with EvoSci update.";

/** The assistant to run `graphId` on for a thread that may run, else null.
 *  The core creates every graph's assistant when it registers a project, so
 *  the ID is computed. */
export function bindingAssistantId(
  binding: ThreadBinding,
  graphId: string
): string | null {
  return binding.kind === "open" || binding.kind === "unbound"
    ? workspaceAssistantId(graphId, binding.key)
    : null;
}

export function canRun(binding: ThreadBinding): boolean {
  return binding.kind === "open" || binding.kind === "unbound";
}

/** Why a sub-agent's task thread that records no project takes no
 *  follow-up. */
export const NO_TASK_PROJECT_REASON =
  "This task doesn't record its project, so it can't be continued here.";

/**
 * Whether a sub-agent's task thread takes a follow-up here. It runs only in
 * the project it records: with no project to fall back to, one that records
 * none can't be told apart from another project's.
 */
export function followUpBinding(
  projects: ProjectsState,
  folders: ThreadFolders | undefined
): ThreadBinding {
  return threadBinding(
    projects,
    folders,
    AGENT_GRAPHS,
    null,
    null,
    NO_TASK_PROJECT_REASON
  );
}
