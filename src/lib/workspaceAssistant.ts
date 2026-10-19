import type { Assistant, Client } from "@langchain/langgraph-sdk";
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

/** The folder a backend serves, from its `GET /api/workspace`. */
export interface ServedWorkspace {
  /** The project root as the core writes it into thread metadata. */
  key: string;
  /** The run folder of a `--mode=run` session holding the server. */
  runDir: string | null;
}

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

/**
 * `graphId`'s assistant for the folder `key`, created if missing. The ID is
 * computed, so this one call returns the existing assistant unchanged or
 * creates it; the server matches on the ID alone.
 */
export function ensureWorkspaceAssistant(
  client: Client,
  graphId: string,
  key: string
): Promise<Assistant> {
  return client.assistants.create({
    graphId,
    assistantId: workspaceAssistantId(graphId, key),
    ifExists: "do_nothing",
    config: { configurable: { workspace_dir: key } },
    metadata: { workspace_dir: key },
    name: `${graphId} · ${folderName(key)}`,
  });
}

/**
 * The folder the backend at `deploymentUrl` serves, or null when the backend
 * has no `GET /api/workspace` (a core older than the route). Throws when the
 * backend can't be reached, so the caller can retry.
 */
export async function fetchServedWorkspace(
  deploymentUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ServedWorkspace | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const res = await fetch(`${deploymentUrl.replace(/\/$/, "")}/api/workspace`, {
    headers,
    cache: "no-store",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    workspace_dir?: unknown;
    run_dir?: unknown;
  };
  if (typeof body.workspace_dir !== "string" || !body.workspace_dir) {
    throw new Error("The backend reported no workspace folder.");
  }
  return {
    key: body.workspace_dir,
    runDir: typeof body.run_dir === "string" ? body.run_dir : null,
  };
}
