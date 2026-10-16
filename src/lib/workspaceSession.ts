import { workspaceAssistantId } from "@/lib/workspaceAssistant";

/** Whether this machine's workspace is the backend's folder, from
 *  `GET /api/workspace/local`. */
export interface LocalFolder {
  dir: string;
  sameFolder: boolean;
}

export type WorkspaceState =
  /** Not known yet: nothing runs until it is. */
  | { status: "pending" }
  /** A core without `GET /api/workspace`: graphs are addressed by name, as
   *  before, with no folder stamping, filtering or folder-based read-only. */
  | { status: "legacy" }
  | {
      status: "ready";
      /** The served folder, as the core writes it into thread metadata. */
      key: string;
      /** Set when a `--mode=run` CLI session holds the backend. */
      runDir: string | null;
      /** Null when this machine has no workspace of its own. */
      local: LocalFolder | null;
      /** The graphs whose assistant for this folder exists. */
      graphs: ReadonlySet<string>;
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

/** The assistant to run `graphId` on: its assistant for the folder, the
 *  graph name on a backend without the route, null when there is none. */
export function assistantIdFor(
  workspace: WorkspaceState,
  graphId: string
): string | null {
  if (workspace.status === "legacy") return graphId;
  if (workspace.status !== "ready" || !workspace.graphs.has(graphId)) {
    return null;
  }
  return workspaceAssistantId(graphId, workspace.key);
}

/**
 * Why the WebUI's own file views are off, or null when they show the
 * backend's folder.
 */
export function localFilesNotice(workspace: WorkspaceState): string | null {
  if (localFilesAvailable(workspace)) return null;
  if (workspace.status === "pending") return "Connecting to the backend…";
  if (workspace.status === "ready" && !workspace.local) {
    return "This machine has no EvoScientist workspace of its own, so the backend's files can't be shown here.";
  }
  return "The files are on the backend's machine: this WebUI can only show files when it runs where the backend's folder is.";
}
