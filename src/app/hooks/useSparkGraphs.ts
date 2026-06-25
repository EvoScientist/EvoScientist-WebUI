"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SPARK_GRAPH_JSON,
  SPARK_GRAPH_LOCK,
  SPARK_MEMORY_PREFIX,
  type SparkGraphSummary,
} from "@/lib/sparkTypes";

interface MemoryEntry {
  path: string;
  size: number;
  mtime: number;
}

interface MemoryListing {
  exists: boolean;
  entries: MemoryEntry[];
}

/**
 * List every idea-spark tree visible under `~/.evoscientist/memories/`. We
 * reuse the existing `/api/memory` recursive walk and filter client-side for
 * entries that look like `idea_spark_tree/<id>/graph.json` — i.e. one path
 * separator past the prefix and ending in graph.json. Anything else under that
 * prefix (sidecar files, future siblings) is ignored here; one row per tree.
 */
export function useSparkGraphs(): {
  graphs: SparkGraphSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [graphs, setGraphs] = useState<SparkGraphSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/memory")
      .then(async (r) => {
        if (!r.ok) throw new Error(`memory list failed: ${r.status}`);
        return (await r.json()) as MemoryListing;
      })
      .then((listing) => {
        if (cancelled) return;
        if (!listing.exists) {
          setGraphs([]);
          return;
        }
        // First pass: collect the set of graph ids whose `graph.lock`
        // sentinel is present — the skill writes this while it holds
        // exclusive access. We surface it as a `locked` flag on each
        // summary so the UI can gate destructive actions (e.g. delete)
        // without waiting for a race-prone 4xx from the server.
        const lockedIds = new Set<string>();
        for (const entry of listing.entries) {
          if (!entry.path.startsWith(SPARK_MEMORY_PREFIX)) continue;
          const rest = entry.path.slice(SPARK_MEMORY_PREFIX.length);
          const parts = rest.split("/");
          if (parts.length !== 2 || parts[1] !== SPARK_GRAPH_LOCK) continue;
          lockedIds.add(parts[0]);
        }
        // Match `idea_spark_tree/<id>/graph.json` exactly — two segments past
        // the prefix, where the second is the canonical filename. Skipping
        // any deeper-nested entries the skill might add later.
        const out: SparkGraphSummary[] = [];
        for (const entry of listing.entries) {
          if (!entry.path.startsWith(SPARK_MEMORY_PREFIX)) continue;
          const rest = entry.path.slice(SPARK_MEMORY_PREFIX.length);
          const parts = rest.split("/");
          if (parts.length !== 2 || parts[1] !== SPARK_GRAPH_JSON) continue;
          out.push({
            id: parts[0],
            path: entry.path,
            mtime: entry.mtime,
            size: entry.size,
            locked: lockedIds.has(parts[0]),
          });
        }
        // Newest first — same convention as the threads list.
        out.sort((a, b) => b.mtime - a.mtime);
        setGraphs(out);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load graphs.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const refresh = useCallback(() => setRevision((v) => v + 1), []);

  return { graphs, loading, error, refresh };
}
