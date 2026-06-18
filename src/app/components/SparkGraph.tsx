"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/providers/ThemeProvider";
import { renderMermaid, type MermaidTheme } from "@/lib/mermaidRenderer";
import type { SparkGraph } from "@/lib/sparkTypes";

interface SparkGraphProps {
  graph: SparkGraph;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

// Escape characters Mermaid treats as label delimiters. Belt-and-suspenders
// since the skill SHOULD escape — but title content reaches us via JSON and we
// have no signal beyond "string", so guard at the boundary.
function mermaidLabel(raw: string): string {
  return raw.replace(/["[\]]/g, " ");
}

// Synthesize the Mermaid source ourselves from the canonical JSON rather than
// reading graph.md — keeps us free of the markdown format and lets us emit
// stable per-node ids the click wiring can target.
//
// Edges are only emitted when BOTH endpoints are in the node set. Callers can
// pass a filtered view (e.g. only the non-rejected nodes) without leaving
// dangling edges that would render as ghost nodes.
function toMermaidSource(graph: SparkGraph): string {
  const presentIds = new Set(graph.nodes.map((n) => n.id));
  const lines: string[] = ["graph LR"];
  for (const n of graph.nodes) {
    lines.push(`  ${n.id}["${mermaidLabel(n.title)}"]`);
  }
  for (const n of graph.nodes) {
    if (n.parent_id && presentIds.has(n.parent_id)) {
      lines.push(`  ${n.parent_id} --> ${n.id}`);
    }
  }
  return lines.join("\n");
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const KEY_ZOOM_STEP = 1.2;
const INITIAL_TRANSFORM = { scale: 1, x: 0, y: 0 } as const;
type Transform = { scale: number; x: number; y: number };

// Per-graph transform cache. Module-level (not in a ref) so it survives the
// brief unmount/remount cycle SparkPanel does while a new graph.json loads —
// otherwise switching A → B → A would always reset the view on A. Scoped to
// the running browser tab; intentionally not persisted to localStorage in
// Phase 1.
const transformsByGraphId = new Map<string, Transform>();

function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

// Scale around a fixed point so the content under that point stays put. Used
// by both wheel-zoom (point = cursor) and key-zoom (point = viewport centre).
function zoomAround(
  current: Transform,
  focalX: number,
  focalY: number,
  newScale: number
): Transform {
  const clamped = clampScale(newScale);
  if (clamped === current.scale) return current;
  const ratio = clamped / current.scale;
  return {
    scale: clamped,
    x: focalX - (focalX - current.x) * ratio,
    y: focalY - (focalY - current.y) * ratio,
  };
}

export function SparkGraph({
  graph,
  selectedNodeId,
  onSelectNode,
}: SparkGraphProps) {
  const reactId = useId().replace(/:/g, "");
  const { resolvedTheme } = useTheme();
  const mermaidTheme: MermaidTheme =
    resolvedTheme === "dark" ? "dark" : "default";
  const [svg, setSvg] = useState<string | null>(null);
  // Initialise from the per-graph cache so a remount (graph swap) restores
  // the user's last view; default if we've never seen this graph before.
  const [transform, setTransform] = useState<Transform>(
    () => transformsByGraphId.get(graph.id) ?? INITIAL_TRANSFORM
  );
  const [isDragging, setIsDragging] = useState(false);

  // The OUTER ref is the viewport (clips, owns wheel/pointer/keyboard).
  // The INNER ref holds the transformed SVG content and is what click
  // delegation queries — it never gets translated *away* from the SVG nodes.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Live drag state lives in a ref because the move handler is registered
  // once and shouldn't re-bind every render.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const source = useMemo(() => toMermaidSource(graph), [graph]);

  // Save the latest transform back to the module-level cache on every
  // change AND on unmount. Cleanup closes over the values from the render
  // that scheduled the effect, so when SparkGraph unmounts the *last*
  // committed `(graphId, transform)` pair is what gets persisted. On the
  // next mount with the same graph id, the useState initialiser above
  // reads it back.
  useEffect(() => {
    return () => {
      transformsByGraphId.set(graph.id, transform);
    };
  }, [graph.id, transform]);

  useEffect(() => {
    let cancelled = false;
    renderMermaid(`spark-${reactId}`, source, mermaidTheme)
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reactId, source, mermaidTheme]);

  // Click handling via event delegation on the CONTENT ref. See the earlier
  // commit for the React + dangerouslySetInnerHTML rationale; the same holds
  // here. Stays on the inner ref because that's where the SVG actually lives.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !svg) return;
    const handleClick = (e: Event) => {
      const target = e.target as Element | null;
      const nodeEl = target?.closest?.("g.node") as SVGGElement | null;
      if (!nodeEl) return;
      const match = nodeEl.id.match(/flowchart-(.+?)-\d+$/);
      if (!match) return;
      onSelectNode(match[1]);
    };
    content.addEventListener("click", handleClick);
    return () => content.removeEventListener("click", handleClick);
  }, [svg, onSelectNode]);

  // Highlight the selected node by toggling a class — color comes from the
  // CSS rule below so this works regardless of mermaid's internal styling.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const nodeEls = content.querySelectorAll<SVGGElement>("g.node");
    nodeEls.forEach((el) => {
      const match = el.id.match(/flowchart-(.+?)-\d+$/);
      if (!match) return;
      el.classList.toggle("spark-node-selected", match[1] === selectedNodeId);
    });
  }, [svg, selectedNodeId]);

  // Wheel-zoom-to-cursor. Attached via addEventListener so we can pass
  // { passive: false } and call preventDefault — otherwise the browser
  // scrolls the page as well. Depends on `svg` because the viewport div
  // only renders once we have an SVG to show — the first mount returns the
  // "Rendering…" placeholder and the ref is null until `svg` populates.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const focalX = e.clientX - rect.left;
      const focalY = e.clientY - rect.top;
      // Trackpad pinch gives small deltaY; mouse wheel gives ±100ish. The
      // exponential keeps both responsive without overshooting on one click.
      const factor = Math.exp(-e.deltaY * 0.0015);
      setTransform((t) => zoomAround(t, focalX, focalY, t.scale * factor));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [svg]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Skip drag-pan when the press lands on a node OR an interactive control
    // (reset button etc.). Otherwise capturing the pointer would suppress the
    // button's click and start an unwanted drag instead.
    const target = e.target as Element | null;
    if (target?.closest?.("g.node, button")) return;
    // Ignore right-click / middle-click — left button only.
    if (e.button !== 0) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: transform.x,
      origY: transform.y,
    };
    setIsDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setTransform((t) => ({
      ...t,
      x: drag.origX + (e.clientX - drag.startX),
      y: drag.origY + (e.clientY - drag.startY),
    }));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const viewport = viewportRef.current;
    if (viewport && viewport.hasPointerCapture(e.pointerId)) {
      viewport.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const reset = useCallback(() => setTransform(INITIAL_TRANSFORM), []);

  // Keyboard shortcuts: 0 = reset, +/= = zoom in, - = zoom out. Anchored to
  // the viewport centre (not the cursor) since there's no cursor coord for
  // a key press. Only fire when the viewport itself has focus so we don't
  // hijack typing elsewhere on the page.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (e.key === "0") {
      e.preventDefault();
      reset();
      return;
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      setTransform((t) =>
        zoomAround(t, rect.width / 2, rect.height / 2, t.scale * KEY_ZOOM_STEP)
      );
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      setTransform((t) =>
        zoomAround(t, rect.width / 2, rect.height / 2, t.scale / KEY_ZOOM_STEP)
      );
    }
  };

  if (!svg) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Rendering…
      </div>
    );
  }

  const transformChanged =
    transform.scale !== INITIAL_TRANSFORM.scale ||
    transform.x !== INITIAL_TRANSFORM.x ||
    transform.y !== INITIAL_TRANSFORM.y;

  return (
    <div
      ref={viewportRef}
      role="application"
      aria-label="Idea graph viewport"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        "relative h-full w-full overflow-hidden p-4 focus:outline-none",
        isDragging ? "cursor-grabbing" : "cursor-grab"
      )}
    >
      <div
        ref={contentRef}
        // transform-origin at 0 0 keeps the math on the wheel handler simple
        // (no centre-offset corrections needed). user-select toggle prevents
        // text from being selected mid-drag.
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "0 0",
          userSelect: isDragging ? "none" : undefined,
        }}
        className={cn(
          "origin-top-left",
          "[&_svg]:h-auto [&_svg]:max-w-none",
          // Hand cursor only on nodes — the surrounding viewport already
          // shows grab/grabbing for the pan affordance.
          "[&_g.node]:cursor-pointer",
          "[&_g.spark-node-selected_rect]:!stroke-[var(--brand)]",
          "[&_g.spark-node-selected_rect]:!stroke-[3px]",
          "[&_g.spark-node-selected_polygon]:!stroke-[var(--brand)]",
          "[&_g.spark-node-selected_polygon]:!stroke-[3px]"
        )}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <button
        type="button"
        onClick={reset}
        disabled={!transformChanged}
        aria-label="Reset zoom and pan"
        title="Reset zoom and pan (0)"
        className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RotateCcw
          className="size-4"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
