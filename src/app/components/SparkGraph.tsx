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

  // Attach click handlers post-render. Mermaid renders each node as a `<g>`
  // with id `flowchart-<our-id>-<counter>`; we recover our id by stripping the
  // prefix and the trailing counter. Listeners are added directly to the SVG
  // elements (no global handlers, no Mermaid `click` directive) so the cleanup
  // stays scoped to this component.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !svg) return;
    const nodeEls = container.querySelectorAll<SVGGElement>("g.node");
    const cleanups: Array<() => void> = [];
    nodeEls.forEach((el) => {
      const match = el.id.match(/^flowchart-(.+)-\d+$/);
      if (!match) return;
      const ourId = match[1];
      const onClick = (e: Event) => {
        e.stopPropagation();
        onSelectNode(ourId);
      };
      el.style.cursor = "pointer";
      el.addEventListener("click", onClick);
      cleanups.push(() => {
        el.style.cursor = "";
        el.removeEventListener("click", onClick);
      });
    });
    return () => cleanups.forEach((c) => c());
  }, [svg, onSelectNode]);

  // Highlight the selected node by toggling a class — color comes from the
  // CSS rule below so this works regardless of mermaid's internal styling.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const nodeEls = container.querySelectorAll<SVGGElement>("g.node");
    nodeEls.forEach((el) => {
      const match = el.id.match(/^flowchart-(.+)-\d+$/);
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
        "[&_g.spark-node-selected_rect]:!stroke-[var(--brand)]",
        "[&_g.spark-node-selected_rect]:!stroke-[3px]",
        "[&_g.spark-node-selected_polygon]:!stroke-[var(--brand)]",
        "[&_g.spark-node-selected_polygon]:!stroke-[3px]"
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
