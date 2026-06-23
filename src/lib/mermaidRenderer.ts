// Shared Mermaid renderer — single source of truth for the Mermaid singleton.
//
// Mermaid is a singleton: `initialize()` is global, and concurrent `render()`
// calls clobber each other's internal DOM state. If two consumers in the app
// (MermaidDiagram for chat, SparkGraph for the idea-spark view) each kept
// their own loader cache, whichever component most recently called
// `initialize()` would set the theme globally — producing the
// "open one tab, the other tab's theme changes" bug.
//
// Here both consumers share one `mermaidLoader` (one import + cached promise)
// and one `renderChain` (one serialization queue). Theme is passed per call
// so a switcheroo between light/dark from different consumers still works.

type MermaidModule = typeof import("mermaid").default;
export type MermaidTheme = "default" | "dark";

let mermaidLoader: Promise<MermaidModule> | null = null;
let renderChain: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => mod.default);
  }
  return mermaidLoader;
}

function initializeMermaid(mermaid: MermaidModule, theme: MermaidTheme) {
  mermaid.initialize({
    startOnLoad: false,
    theme,
    // "strict" forbids raw HTML in node labels — safer for AI-generated
    // diagram source rendered alongside user content.
    securityLevel: "strict",
  });
}

/**
 * Render a Mermaid source string to SVG.
 *
 * Returns `null` if the source fails to parse (callers can render a fallback).
 * Calls are serialized through the shared chain — concurrent invocations from
 * different components are safe.
 */
export async function renderMermaid(
  id: string,
  source: string,
  theme: MermaidTheme
): Promise<string | null> {
  const next = renderChain.then(async () => {
    const mermaid = await loadMermaid();
    initializeMermaid(mermaid, theme);
    // parse() with suppressErrors gives a boolean instead of the "red bomb"
    // error-SVG that render() produces on bad input.
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    if (!parsed) return null;
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  // Keep the chain alive even if this link throws — otherwise one bad
  // diagram would freeze every subsequent render call.
  renderChain = next.catch(() => undefined);
  return next;
}
