"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, RotateCw, Sparkles } from "lucide-react";
import { useSparkGraphs } from "@/app/hooks/useSparkGraphs";
import { useSparkGraph } from "@/app/hooks/useSparkGraph";
import { SparkGraph } from "@/app/components/SparkGraph";
import { SparkNodeDetail } from "@/app/components/SparkNodeDetail";
import { partitionGraphByRejection } from "@/lib/sparkTypes";
import { cn } from "@/lib/utils";

/**
 * Top-level Idea Spark view. Three regions, hidden when irrelevant:
 *
 *   [ graph list  |    Mermaid graph    | node detail ]
 *      240px                 flex            360px
 *                                            (when a node is selected)
 *
 * Phase 1: read-only. Click on a node opens the detail panel; "Open thread"
 * inside the detail navigates back to the originating chat. Graphs come from
 * the existing memory API (no new endpoint) — see useSparkGraphs.
 */
export function SparkPanel() {
  const { graphs, loading, error, refresh } = useSparkGraphs();
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const {
    graph,
    loading: graphLoading,
    error: graphError,
    refresh: refreshGraph,
  } = useSparkGraph(selectedGraphId);

  // Auto-select the newest graph when the list resolves and nothing's chosen.
  // Re-runs if `graphs` changes (e.g. refresh after the skill writes a new
  // tree) but only if no manual selection is sitting on a stale id.
  useEffect(() => {
    if (graphs.length === 0) {
      setSelectedGraphId(null);
      return;
    }
    setSelectedGraphId((current) => {
      if (current && graphs.some((g) => g.id === current)) return current;
      return graphs[0].id;
    });
  }, [graphs]);

  // Clear the selected node when the graph changes — node ids are graph-local.
  useEffect(() => setSelectedNodeId(null), [selectedGraphId]);

  const selectedNode = useMemo(() => {
    if (!graph || !selectedNodeId) return null;
    return graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [graph, selectedNodeId]);

  // Active graph (renderable) + each rejected subtree split out. Memoised on
  // `graph` so toggling rejection (which produces a fresh graph reference via
  // refresh) recomputes, but mouse-move / selection updates don't.
  const partition = useMemo(
    () => (graph ? partitionGraphByRejection(graph) : null),
    [graph]
  );
  const [rejectedOpen, setRejectedOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles
          className="size-4 text-[var(--brand)]"
          aria-hidden="true"
        />
        <h2 className="text-base font-semibold">Idea Spark</h2>
        <span className="text-xs text-muted-foreground">
          Research idea graphs
        </span>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh graph list"
          title="Refresh"
          className="ml-auto rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCw
            className={cn("size-3.5", loading && "animate-spin")}
            aria-hidden="true"
          />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 flex-shrink-0 flex-col border-r border-border bg-background">
          <div className="flex-shrink-0 border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Graphs
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {loading && graphs.length === 0 && (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                <Loader2
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
                Loading…
              </div>
            )}
            {error && (
              <div className="px-3 py-2 text-xs text-destructive">{error}</div>
            )}
            {!loading && !error && graphs.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No Idea Spark graphs yet. Ask EvoScientist to start one from a
                research direction.
              </div>
            )}
            <ul className="space-y-0.5">
              {graphs.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedGraphId(g.id)}
                    aria-current={selectedGraphId === g.id}
                    className={cn(
                      "w-full truncate px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedGraphId === g.id && "bg-accent"
                    )}
                    title={g.id}
                  >
                    {g.id}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {!selectedGraphId && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Pick a graph on the left.
            </div>
          )}
          {selectedGraphId && graphLoading && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2
                className="mr-2 size-4 animate-spin"
                aria-hidden="true"
              />
              Loading graph…
            </div>
          )}
          {selectedGraphId && graphError && (
            <div className="flex h-full items-center justify-center px-6 text-sm text-destructive">
              {graphError}
            </div>
          )}
          {graph && partition && !graphLoading && !graphError && (
            <>
              {/* Active region — fills the available height. If every node has
                  been rejected, the active graph would be empty; show a
                  placeholder so the user has a hint they can expand the
                  rejected section to find their data. */}
              <div className="min-h-0 flex-1">
                {partition.active.nodes.length > 0 ? (
                  <SparkGraph
                    graph={partition.active}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    Every node in this graph has been rejected. Expand the
                    Rejected section below to see them.
                  </div>
                )}
              </div>
              {/* Rejected region — only when there's at least one rejected
                  node. ALL rejected nodes render in one shared SparkGraph;
                  Mermaid handles disconnected components as multiple clusters
                  within the same diagram, so unrelated rejections share one
                  pan/zoom surface instead of fragmenting into separate cards.
                  Clicking a node in here still opens the same right-side
                  detail panel so Restore is one click away. */}
              {partition.rejected && (
                <section className="bg-surface/30 flex flex-shrink-0 flex-col border-t border-border">
                  <button
                    type="button"
                    aria-expanded={rejectedOpen}
                    onClick={() => setRejectedOpen((v) => !v)}
                    className="flex items-center gap-2 px-4 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        rejectedOpen && "rotate-90"
                      )}
                    />
                    <span>Rejected ({partition.rejected.nodes.length})</span>
                  </button>
                  {rejectedOpen && (
                    <div className="p-3">
                      <div className="h-[35vh] min-h-[220px] overflow-hidden rounded-md border border-border bg-background">
                        <SparkGraph
                          graph={partition.rejected}
                          selectedNodeId={selectedNodeId}
                          onSelectNode={setSelectedNodeId}
                        />
                      </div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
        {selectedNode && graph && (
          <div className="w-[360px] flex-shrink-0">
            <SparkNodeDetail
              node={selectedNode}
              graph={graph}
              onClose={() => setSelectedNodeId(null)}
              onGraphUpdated={refreshGraph}
            />
          </div>
        )}
      </div>
    </div>
  );
}
