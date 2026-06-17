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
