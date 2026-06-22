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

/**
 * Palette for per-thread node colouring. Deterministic — the same `thread_id`
 * always maps to the same colour, both for the Mermaid node fill in
 * `SparkGraph` and for the swatch in `SparkNodeDetail`, so the user can
 * eyeball provenance without checking ids.
 *
 * Generated in OKLCH at constant L=0.75, C=0.07, hue stepped 45° around the
 * wheel and converted to sRGB hex. The constant lightness/chroma means each
 * colour feels equally "important" (no aggressive yellows or washed-out
 * blues), with text contrast that stays readable against Mermaid's default
 * label colours in both light and dark themes. Muted enough that the fills
 * don't clash with the brand-blue selection ring.
 *
 * With more than 8 distinct threads on one graph two threads collide —
 * acceptable for the Phase 3 MVP.
 */
const THREAD_COLOR_PALETTE = [
  "#d49cac", // dusty rose
  "#d4a089", // peach
  "#bfad7b", // khaki
  "#9bb88c", // sage
  "#7bbdaf", // teal
  "#7db8d0", // sky
  "#9cacdb", // lavender
  "#bfa1cd", // lilac
] as const;

/**
 * Alpha applied to thread-colour fills (Mermaid via `fill-opacity`, swatch via
 * `rgba()`). The translucency lets the canvas show through, matching the
 * airy "opaque-but-not-flat" feel of Mermaid's default node fills.
 */
export const THREAD_COLOR_ALPHA = 0.5;

/**
 * localStorage key prefix used to hand a composer prefill from `SparkNodeDetail`
 * to `ChatInterface`. Keyed by the destination `thread_id` so multiple in-flight
 * actions can't trample each other. Consumed once and cleared on pickup.
 */
export const SPARK_PREFILL_STORAGE_PREFIX = "spark-prefill:";

/**
 * Deterministic hex colour for a node's originating thread. Pure function of
 * `thread_id` — no per-graph state, so two graphs that share a thread show
 * the same colour. Uses djb2-style hashing for cheap, well-spread bucketing.
 *
 * Caller is responsible for applying `THREAD_COLOR_ALPHA` if it wants the
 * translucent look: Mermaid uses `fill-opacity` as a sibling style property,
 * the swatch in `SparkNodeDetail` uses `threadIdToColorRgba` so its border
 * keeps the same alpha treatment via the inline style.
 */
export function threadIdToColor(threadId: string): string {
  let hash = 5381;
  for (let i = 0; i < threadId.length; i += 1) {
    hash = (hash * 33) ^ threadId.charCodeAt(i);
  }
  return THREAD_COLOR_PALETTE[Math.abs(hash) % THREAD_COLOR_PALETTE.length];
}

/**
 * Same colour as `threadIdToColor` but pre-multiplied with the translucent
 * alpha and emitted as an `rgba()` string. Convenient for places that go
 * through CSS `background-color` rather than the SVG `fill-opacity` pair.
 */
export function threadIdToColorRgba(threadId: string): string {
  const hex = threadIdToColor(threadId);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${THREAD_COLOR_ALPHA})`;
}

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

/**
 * Build the chat-composer prefill that triggers `idea-elaborate` on `node`.
 * Verbatim from `.backend-ref/notes/idea-elaborate-webui-contract.md` — the
 * skill keys on this exact shape, and the generic agent falls back to it as
 * load-bearing context when the skill isn't installed. The `References` line
 * is omitted when the node has none (the contract treats that as "omit",
 * not "empty").
 *
 * Stage-5 (paper draft) is opt-in: the user adds one of the contract's
 * keywords ("draft a paper", "manuscript", …) before submitting. The default
 * prefill does NOT include them — see the inline hint in `SparkNodeDetail`.
 */
export function buildElaborateTriggerMessage(
  node: SparkNode,
  graph: SparkGraph
): string {
  const lines = [
    `Please elaborate on the next action for "${node.title}" (node id: ${node.id}) in the`,
    `"${graph.name}" idea-spark graph. The next action is:`,
    "",
    `> ${node.next_action ?? ""}`,
    "",
  ];
  if (node.references && node.references.length > 0) {
    lines.push(
      `References attached to the node: ${node.references.join(", ")}`
    );
  }
  lines.push(`Originating thread: ${node.thread_id}`);
  return lines.join("\n");
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
 * `parent_id` links downward. Used by reject (mark all in subtree) and
 * restore (subtree half of the restore cascade).
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
 * Return the set of node ids on the path from `startId` up to the root,
 * inclusive. Used by restore's UPWARD cascade — if a node is OK to keep,
 * everything it stems from must also be OK to keep.
 */
export function ancestorNodeIds(
  nodes: SparkNode[],
  startId: string
): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parent_id);
  const out = new Set<string>([startId]);
  let cursor: string | null = parentOf.get(startId) ?? null;
  while (cursor !== null && !out.has(cursor)) {
    out.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return out;
}

/**
 * Split a graph into two views: the active set (non-rejected nodes) and the
 * combined rejected set (every node with `rejected === true`).
 *
 * The rejected view collects ALL rejected nodes into a single SparkGraph
 * rather than one-per-subtree. Mermaid renders disconnected components
 * naturally — two unrelated rejected subtrees show up as two clusters within
 * the same diagram, sharing a single pan/zoom surface. The synthesised id
 * (`<orig>#rejected`) keeps the rejected view's transform cache distinct
 * from the active view's. The synthesised id is display/cache-only; writes
 * flow through the original graph object held by SparkPanel.
 *
 * `rejected` is `null` when there is nothing to render.
 */
export function partitionGraphByRejection(graph: SparkGraph): {
  active: SparkGraph;
  rejected: SparkGraph | null;
} {
  const isNodeRejected = (n: SparkNode) => n.rejected === true;
  const active: SparkGraph = {
    ...graph,
    nodes: graph.nodes.filter((n) => !isNodeRejected(n)),
  };
  const rejectedNodes = graph.nodes.filter(isNodeRejected);
  const rejected: SparkGraph | null =
    rejectedNodes.length > 0
      ? {
          ...graph,
          id: `${graph.id}#rejected`,
          nodes: rejectedNodes,
        }
      : null;
  return { active, rejected };
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
 * Restore `nodeId` along both the path UP to the root (its ancestors) and the
 * subtree rooted at `nodeId` (its descendants). The combined "valid spine"
 * captures the rule "if this idea is OK, then what it stems from is OK and
 * what stems from it is OK." Siblings of the restored chain are untouched —
 * they stay in whatever state the user left them.
 *
 * Removes the `rejected` field rather than setting it to `false`, so the
 * persisted JSON stays minimal for the common (all-accepted) case.
 */
export function restoreCascade(graph: SparkGraph, nodeId: string): SparkGraph {
  const ancestors = ancestorNodeIds(graph.nodes, nodeId);
  const subtree = subtreeNodeIds(graph.nodes, nodeId);
  const targets = new Set<string>([...ancestors, ...subtree]);
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
