// Idea Spark client-side types.
//
// Mirrors the SCHEMA.md contract owned by the `idea-spark` skill in the
// EvoScientist backend repo. The skill is the WRITER; the WebUI is the READER.
// Per the contract, the reader MUST tolerate both presence and absence of
// optional node fields, and MUST ignore unknown fields without erroring.

export const SPARK_SCHEMA_VERSION = 1;

/** Path prefix in the global memory dir where idea-spark trees live. */
export const SPARK_MEMORY_PREFIX = "idea_spark_tree/";

/** Filename within each tree dir that holds the canonical state. */
export const SPARK_GRAPH_JSON = "graph.json";

/**
 * Sentinel the skill writes while it holds exclusive write access. Absent /
 * removed when the skill is idle. Not dot-prefixed because the memory API
 * hides anything starting with "." from listings and reads (`isHiddenEntry`
 * in `src/lib/server/memory.ts`), which would make a `.lock` invisible.
 */
export const SPARK_GRAPH_LOCK = "graph.lock";

export interface SparkNode {
  /** Stable across skill runs once assigned. */
  id: string;
  /** null marks the (single, in Phase 1) root. */
  parent_id: string | null;
  /** LangGraph thread id where this idea was produced. Used for click-through. */
  thread_id: string;
  /** Mermaid-safe one-line label. */
  title: string;

  // Optional fields per the schema's "Phase 1, writer-only" section.
  // The reader displays them when present, ignores them when absent.
  description?: string;
  next_action?: string;
  references?: string[];
  /** Per-node creation time, set once. Distinct from the graph's `created_at`. */
  created_at?: string;
  /** Phase 2: user-rejected. Absent or false = accepted (the default). Reject
   *  and restore both cascade DOWN — the field is written on every descendant
   *  by the mutator, so render-time checks can just read this directly. */
  rejected?: boolean;
}

export interface SparkGraph {
  schema_version: number;
  /** Sanitized graph id — matches the directory name under idea_spark_tree/. */
  id: string;
  /** User-given display name, unsanitized. */
  name: string;
  created_at: string;
  updated_at: string;
  nodes: SparkNode[];
}

/** Listing item — just enough to render the graph picker. */
export interface SparkGraphSummary {
  /** Sanitized id (directory name). */
  id: string;
  /** Memory-relative path to graph.json (`idea_spark_tree/<id>/graph.json`). */
  path: string;
  /** Last modification time of graph.json, ms since epoch. */
  mtime: number;
  /** File size in bytes (useful for filtering empty/broken files). */
  size: number;
}

/**
 * Return the set of node ids reachable from `rootId` (inclusive), following
 * `parent_id` links downward. Used by both reject (mark all) and restore
 * (unmark all) so the cascade is consistent both directions.
 */
export function subtreeNodeIds(
  nodes: SparkNode[],
  rootId: string
): Set<string> {
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    const arr = childrenOf.get(n.parent_id) ?? [];
    arr.push(n.id);
    childrenOf.set(n.parent_id, arr);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const childId of childrenOf.get(id) ?? []) {
      if (out.has(childId)) continue;
      out.add(childId);
      stack.push(childId);
    }
  }
  return out;
}

/**
 * Reject `nodeId` and every descendant. Returns a new graph with the cascade
 * applied and `updated_at` advanced. Pure — does not write anywhere.
 */
export function rejectCascade(graph: SparkGraph, nodeId: string): SparkGraph {
  const targets = subtreeNodeIds(graph.nodes, nodeId);
  return {
    ...graph,
    updated_at: new Date().toISOString(),
    nodes: graph.nodes.map((n) =>
      targets.has(n.id) ? { ...n, rejected: true } : n
    ),
  };
}

/**
 * Restore `nodeId` and every descendant. Removes the `rejected` field rather
 * than setting it to `false`, so the persisted JSON stays minimal for the
 * common (all-accepted) case.
 */
export function restoreCascade(graph: SparkGraph, nodeId: string): SparkGraph {
  const targets = subtreeNodeIds(graph.nodes, nodeId);
  return {
    ...graph,
    updated_at: new Date().toISOString(),
    nodes: graph.nodes.map((n) => {
      if (!targets.has(n.id)) return n;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { rejected, ...rest } = n;
      return rest;
    }),
  };
}

/** Returned when a write is blocked by the skill's lock file. */
export class SparkGraphLockedError extends Error {
  constructor(graphId: string) {
    super(
      `The skill is currently updating "${graphId}". Try again in a moment.`
    );
    this.name = "SparkGraphLockedError";
  }
}

interface MemoryEntry {
  path: string;
}
interface MemoryListing {
  exists: boolean;
  entries: MemoryEntry[];
}

/**
 * True if the skill currently holds the lock on this graph. A single GET
 * against the memory listing — no polling. We deliberately re-check at write
 * time only (see `writeSparkGraph`), per the "no state tracing by webui"
 * design rule.
 */
export async function isGraphLocked(graphId: string): Promise<boolean> {
  const lockRelPath = `${SPARK_MEMORY_PREFIX}${graphId}/${SPARK_GRAPH_LOCK}`;
  const res = await fetch("/api/memory");
  if (!res.ok) return false;
  const listing = (await res.json()) as MemoryListing;
  if (!listing.exists) return false;
  return listing.entries.some((e) => e.path === lockRelPath);
}

/**
 * Write a graph back to the memory store via the existing /api/memory route.
 * Pretty-printed for human-friendly diffs when the user inspects the file.
 * On failure we extract the API's `{ error }` body so the surfaced message is
 * the actual reason (e.g. "Cross-origin memory access is not allowed.") rather
 * than a bare status code.
 *
 * Throws `SparkGraphLockedError` if the skill currently holds `graph.lock` on
 * this graph — the caller decides how to surface it (toast, button state).
 * The check is a best-effort guard against clobbering the skill mid-write; a
 * small race window remains between the check and the PUT, acknowledged by
 * the Phase 2 design.
 */
export async function writeSparkGraph(graph: SparkGraph): Promise<void> {
  if (await isGraphLocked(graph.id)) {
    throw new SparkGraphLockedError(graph.id);
  }
  const path = `${SPARK_MEMORY_PREFIX}${graph.id}/${SPARK_GRAPH_JSON}`;
  const res = await fetch("/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      content: JSON.stringify(graph, null, 2),
    }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) {
        detail = `${body.error} (HTTP ${res.status})`;
      }
    } catch {
      // Response body wasn't JSON — keep the bare status code.
    }
    throw new Error(detail);
  }
}
