"use client";

import React, { useEffect, useId, useState } from "react";
import { CodeBlock } from "./CodeBlock";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

interface MermaidDiagramProps {
  code: string;
  /** While true, skip rendering — fall back to the source view. */
  isStreaming?: boolean;
}

// Mermaid is a singleton with shared internal DOM state. Concurrent render()
// calls clobber each other and silently drop SVGs, so we serialize every
// call through this promise chain. Also caches the mermaid import + the
// one-time initialize() so they don't run per-diagram.
type MermaidModule = typeof import("mermaid").default;
let mermaidLoader: Promise<MermaidModule> | null = null;
let renderChain: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "dark",
        // "strict" forbids raw HTML in node labels — safer for AI-generated
        // diagram source rendered alongside user content.
        securityLevel: "strict",
      });
      return mod.default;
    });
  }
  return mermaidLoader;
}

async function renderMermaid(id: string, code: string): Promise<string | null> {
  const next = renderChain.then(async () => {
    const mermaid = await loadMermaid();
    // parse() with suppressErrors gives a boolean instead of the "red bomb"
    // error-SVG that render() produces on bad input.
    const parsed = await mermaid.parse(code, { suppressErrors: true });
    if (!parsed) return null;
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
  // Keep the chain alive even if this link throws — otherwise one bad
  // diagram would freeze every subsequent render call.
  renderChain = next.catch(() => undefined);
  return next;
}

export const MermaidDiagram = React.memo<MermaidDiagramProps>(
  ({ code, isStreaming = false }) => {
    // useId is React 19's stable-across-renders unique id. Mermaid needs a
    // CSS-safe id; useId returns strings like ":r3:" so strip the colons.
    const reactId = useId().replace(/:/g, "");
    const [svg, setSvg] = useState<string | null>(null);

    useEffect(() => {
      // Skip while the message is still streaming — `code` changes on every
      // token, and queuing a render per change would back up mermaid's
      // serialized chain and freeze the UI. Renders kick off once streaming
      // ends (this effect re-runs because isStreaming is in the deps).
      if (isStreaming) return;
      let cancelled = false;
      renderMermaid(`mermaid-${reactId}`, code)
        .then((result) => {
          if (!cancelled) setSvg(result);
        })
        .catch(() => {
          if (!cancelled) setSvg(null);
        });
      return () => {
        cancelled = true;
      };
    }, [code, reactId, isStreaming]);

    // During streaming the source grows token-by-token. Avoid the syntax
    // highlighter here — it re-tokenizes the full string on every keystroke
    // and, multiplied across several diagrams, freezes the main thread.
    if (isStreaming) {
      return (
        <pre className="my-4 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-surface p-3 text-xs text-[var(--color-text-tertiary)]">
          <code>{code}</code>
        </pre>
      );
    }
    if (!svg) {
      return <CodeBlock language="mermaid" value={code} />;
    }
    return <MermaidPreview svg={svg} />;
  }
);
MermaidDiagram.displayName = "MermaidDiagram";

const MermaidPreview = React.memo<{ svg: string }>(({ svg }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="Open diagram in full view"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="my-4 max-w-full cursor-zoom-in overflow-x-auto rounded-md bg-surface p-4 transition-shadow hover:ring-2 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-[90vw] overflow-auto p-6 sm:max-w-[90vw]">
          <DialogTitle className="sr-only">Mermaid diagram</DialogTitle>
          <div
            className="[&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
});
MermaidPreview.displayName = "MermaidPreview";
