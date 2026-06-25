"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Loader2,
  Lock,
  RotateCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useSparkGraphs } from "@/app/hooks/useSparkGraphs";
import { useSparkGraph } from "@/app/hooks/useSparkGraph";
import { SparkGraph } from "@/app/components/SparkGraph";
import { SparkNodeDetail } from "@/app/components/SparkNodeDetail";
import {
  deleteSparkGraph,
  partitionGraphByRejection,
  type SparkGraphSummary,
} from "@/lib/sparkTypes";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

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

  // Delete-graph flow — mirrors the ThreadList "delete this research?"
  // pattern: an explicit confirmation dialog, an actionBusy gate to keep
  // Escape / backdrop from closing mid-delete, and a refresh + selection
  // clear once the server returns. We surface skipped subdirectories
  // (e.g. orphaned `elaborations/`) as a follow-up toast so the user can
  // clean up via the Memory view if they want.
  const [deleteTarget, setDeleteTarget] = useState<SparkGraphSummary | null>(
    null
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteBusyRef = useRef(false);
  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusyRef.current) return;
    deleteBusyRef.current = true;
    setDeleteBusy(true);
    try {
      const report = await deleteSparkGraph(deleteTarget.id);
      if (selectedGraphId === deleteTarget.id) {
        setSelectedGraphId(null);
      }
      setDeleteTarget(null);
      refresh();
      if (report.skippedDirs.length > 0) {
        toast.message(
          `Graph removed; ${
            report.skippedDirs.length
          } subdirectory(ies) remained (${report.skippedDirs.join(
            ", "
          )}). Clean up via the Memory view if needed.`
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Couldn't delete: ${err.message}`
          : "Couldn't delete — try again."
      );
    } finally {
      deleteBusyRef.current = false;
      setDeleteBusy(false);
    }
  };

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
        {/* Graphs sidebar + main viewport are a resizable pair. The user's
            chosen width persists across reloads via `autoSaveId`. The node
            detail panel (when open) stays *outside* the group as a fixed
            right-side flex sibling — resizing it would compete with the
            graph viewport's pan/zoom area, so the simpler choice is to
            keep that one at the constant width set in the SparkNodeDetail
            design. */}
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="spark-sidebar-width"
          className="flex-1"
        >
          <ResizablePanel
            defaultSize={20}
            minSize={12}
            maxSize={45}
          >
            <aside className="flex h-full flex-col border-r border-border bg-background">
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
                  <div className="px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
                {!loading && !error && graphs.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    No Idea Spark graphs yet. Ask EvoScientist to start one from
                    a research direction.
                  </div>
                )}
                <ul className="space-y-0.5">
                  {graphs.map((g) => (
                    <li
                      key={g.id}
                      className="group relative"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedGraphId(g.id)}
                        aria-current={selectedGraphId === g.id}
                        className={cn(
                          "w-full truncate py-1.5 pl-8 pr-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          selectedGraphId === g.id && "bg-accent"
                        )}
                        title={g.id}
                      >
                        {g.id}
                      </button>
                      {/* Trash sits in the gutter on the left, revealed on hover
                      or keyboard focus (same pattern as the chat row). The
                      lock icon replaces it when the skill is mid-write; we
                      keep that one visible at all times so the user can see
                      WHY the row is uninteractable. */}
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(g)}
                        disabled={g.locked}
                        aria-label={
                          g.locked
                            ? `"${g.id}" is locked by the skill`
                            : `Delete "${g.id}"`
                        }
                        title={
                          g.locked
                            ? "Skill is using this graph — try again in a moment."
                            : "Delete graph"
                        }
                        className={cn(
                          "absolute left-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
                          g.locked
                            ? "opacity-50"
                            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                        )}
                      >
                        {g.locked ? (
                          <Lock
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={80}>
            <main className="flex h-full min-w-0 flex-col">
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
                        <span>
                          Rejected ({partition.rejected.nodes.length})
                        </span>
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
          </ResizablePanel>
        </ResizablePanelGroup>
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
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this graph?</DialogTitle>
            <DialogDescription>
              &ldquo;{deleteTarget?.id}&rdquo; and its sibling files
              (graph.json, lock) will be permanently removed. Subdirectories
              such as <span className="font-mono">elaborations/</span> are left
              untouched; you can clean those up via the Memory view. This
              can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deleteBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
