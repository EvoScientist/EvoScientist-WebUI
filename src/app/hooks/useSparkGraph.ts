"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SPARK_GRAPH_JSON,
  SPARK_MEMORY_PREFIX,
  SPARK_SCHEMA_VERSION,
  type SparkGraph,
} from "@/lib/sparkTypes";

interface MemoryFile {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

/**
 * Load one graph.json by graph id. The id matches the directory name under
 * idea_spark_tree/. Returns `null` while loading and on error (with `error`
 * populated). Unknown fields beyond the typed shape are silently ignored on
 * parse — the SCHEMA.md contract requires the reader to tolerate them.
 */
export function useSparkGraph(graphId: string | null): {
  graph: SparkGraph | null;
  loading: boolean;
  error: string | null;
  /** Bump to re-fetch — e.g. after a mutation persists. */
  refresh: () => void;
} {
  const [graph, setGraph] = useState<SparkGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);

  useEffect(() => {
    if (!graphId) {
      setGraph(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const path = `${SPARK_MEMORY_PREFIX}${graphId}/${SPARK_GRAPH_JSON}`;
    fetch(`/api/memory?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`graph read failed: ${r.status}`);
        return (await r.json()) as MemoryFile;
      })
      .then((file) => {
        if (cancelled) return;
        let parsed: SparkGraph;
        try {
          parsed = JSON.parse(file.content) as SparkGraph;
        } catch {
          throw new Error("graph.json is not valid JSON");
        }
        if (
          typeof parsed.schema_version !== "number" ||
          parsed.schema_version !== SPARK_SCHEMA_VERSION
        ) {
          // Don't hard-fail — surface the mismatch so the UI can warn the user
          // without breaking. A future Phase 2 schema bump might still be
          // partially renderable as a Phase 1 tree.
          console.warn(
            `[spark] unexpected schema_version ${parsed.schema_version}, expected ${SPARK_SCHEMA_VERSION}`
          );
        }
        if (!Array.isArray(parsed.nodes)) {
          throw new Error("graph.json is missing nodes array");
        }
        setGraph(parsed);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load graph.");
        setGraph(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graphId, revision]);

  return { graph, loading, error, refresh };
}
