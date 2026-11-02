import { v5 as uuidv5 } from "uuid";

/**
 * Namespace of workspace assistant IDs:
 * `uuid5(NAMESPACE_URL, "https://github.com/EvoScientist/EvoScientist")`.
 * The core derives the same IDs, so the CLI and the WebUI land on one
 * assistant per graph and folder.
 */
export const WORKSPACE_ASSISTANT_NAMESPACE =
  "35e045d5-e927-554e-9f04-4ba98f84c54c";

/** The graph the chat runs. */
export const CHAT_GRAPH_ID = "EvoScientist";
/** The graph scheduled tasks run. */
export const SCHEDULER_GRAPH_ID = "scheduler";

/** The ID of `graphId`'s assistant for the folder `key`. The newline keeps
 *  the graph ID and the path apart. */
export function workspaceAssistantId(graphId: string, key: string): string {
  return uuidv5(`${graphId}\n${key}`, WORKSPACE_ASSISTANT_NAMESPACE);
}

/** The last segment of a folder key, for labels. */
export function folderName(key: string): string {
  const parts = key.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? key;
}
