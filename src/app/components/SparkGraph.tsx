"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { SparkGraph } from "@/lib/sparkTypes";

interface SparkGraphProps {
  graph: SparkGraph;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

// Same singleton-serialization pattern as MermaidDiagram — mermaid is a
// singleton with shared internal DOM state, so concurrent render() calls
// clobber each other. Cache the import + initialize() too.
type MermaidModule = typeof import("mermaid").default;
let mermaidLoader: Promise<MermaidModule> | null = null;
let renderChain: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "dark",
        // Strict mode forbids raw HTML in node labels — safer for content
        // sourced from the agent-emitted graph.json.
        securityLevel: "strict",
      });
      return mod.default;
    });
  }
  return mermaidLoader;
}

async function renderMermaid(
  id: string,
  source: string
): Promise<string | null> {
  const next = renderChain.then(async () => {
    const mermaid = await loadMermaid();
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    if (!parsed) return null;
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  renderChain = next.catch(() => undefined);
  return next;
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
function toMermaidSource(graph: SparkGraph): string {
  const lines: string[] = ["graph LR"];
  for (const n of graph.nodes) {
    lines.push(`  ${n.id}["${mermaidLabel(n.title)}"]`);
  }
  for (const n of graph.nodes) {
    if (n.parent_id) lines.push(`  ${n.parent_id} --> ${n.id}`);
  }
  return lines.join("\n");
}

export function SparkGraph({
  graph,
  selectedNodeId,
  onSelectNode,
}: SparkGraphProps) {
  const reactId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Re-render on any graph mutation. The source text is the dep so identical
  // graphs from different objects don't trigger redundant work.
  const source = toMermaidSource(graph);
  useEffect(() => {
    let cancelled = false;
    renderMermaid(`spark-${reactId}`, source)
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reactId, source]);

  // Click handling via event delegation on the container — which React owns
  // and never replaces — so we keep working clicks across re-renders.
  //
  // Direct per-node listeners would die the first time a parent re-render
  // makes React re-apply `dangerouslySetInnerHTML`: Mermaid's SVG round-trips
  // through innerHTML in a way that doesn't byte-equal what React last set,
  // so React replaces the SVG subtree, removing the per-node listeners. With
  // delegation, only the container's listener matters and it survives every
  // SVG re-application. Mermaid's `<g>` id format is
  // `spark-<reactid>-flowchart-<our-id>-<counter>`, so the non-anchored regex
  // finds the trailing `flowchart-…-<counter>` and a non-greedy capture
  // pulls out our original node id.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !svg) return;
    const handleClick = (e: Event) => {
      const target = e.target as Element | null;
      const nodeEl = target?.closest?.("g.node") as SVGGElement | null;
      if (!nodeEl) return;
      const match = nodeEl.id.match(/flowchart-(.+?)-\d+$/);
      if (!match) return;
      onSelectNode(match[1]);
    };
    container.addEventListener("click", handleClick);
    return () => container.removeEventListener("click", handleClick);
  }, [svg, onSelectNode]);

  // Highlight the selected node by toggling a class — color comes from the
  // CSS rule below so this works regardless of mermaid's internal styling.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nodeEls = container.querySelectorAll<SVGGElement>("g.node");
    nodeEls.forEach((el) => {
      const match = el.id.match(/flowchart-(.+?)-\d+$/);
      if (!match) return;
      el.classList.toggle("spark-node-selected", match[1] === selectedNodeId);
    });
  }, [svg, selectedNodeId]);

  if (!svg) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Rendering…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // [&_svg] reaches into the rendered Mermaid SVG so we can size it
      // naturally and apply the selection highlight class via descendant
      // selector — mermaid's internal styling is tagged with !important so
      // we ride alongside rather than fight it.
      className={cn(
        "h-full w-full overflow-auto p-4",
        "[&_svg]:h-auto [&_svg]:max-w-full",
        // Hand cursor on every Mermaid node — survives SVG re-applications
        // (inline styles would be wiped along with the listeners).
        "[&_g.node]:cursor-pointer",
        "[&_g.spark-node-selected_rect]:!stroke-[var(--brand)]",
        "[&_g.spark-node-selected_rect]:!stroke-[3px]",
        "[&_g.spark-node-selected_polygon]:!stroke-[var(--brand)]",
        "[&_g.spark-node-selected_polygon]:!stroke-[3px]"
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
