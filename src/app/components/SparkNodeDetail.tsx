"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Copy, X } from "lucide-react";
import { useQueryState } from "nuqs";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { SparkNode } from "@/lib/sparkTypes";

// Per SCHEMA.md, references[] may contain plain URLs OR academic ids
// (e.g. "arXiv:2212.04356", "doi:10.NNNN/..."). Resolve the known short
// forms to canonical URLs so the link renders correctly. Anything we don't
// recognise is left as plain text rather than a broken `<a href>`.
function resolveReference(ref: string): { href: string | null; label: string } {
  const trimmed = ref.trim();
  // Plain URL (http or https) — pass through.
  if (/^https?:\/\//i.test(trimmed)) return { href: trimmed, label: trimmed };
  // arXiv id, e.g. "arXiv:2212.04356" or "arxiv:2212.04356v2".
  const arxivMatch = trimmed.match(/^arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
  if (arxivMatch) {
    return {
      href: `https://arxiv.org/abs/${arxivMatch[1]}`,
      label: trimmed,
    };
  }
  // DOI, e.g. "doi:10.1000/xyz" or bare "10.1000/xyz".
  const doiMatch = trimmed.match(/^(?:doi:\s*)?(10\.\d{4,}\/\S+)$/i);
  if (doiMatch) {
    return {
      href: `https://doi.org/${doiMatch[1]}`,
      label: trimmed,
    };
  }
  return { href: null, label: trimmed };
}

// LangGraph thread ids are UUIDs (any RFC 4122 version). The skill is
// supposed to emit one of these, but bad data leaks through (e.g. internal
// checkpoint ids). Validate before letting the user click Open thread so
// they don't hit a 422 from the backend.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeThreadId(id: string): boolean {
  return UUID_RE.test(id.trim());
}

interface SparkNodeDetailProps {
  node: SparkNode;
  onClose: () => void;
}

/**
 * Right-side detail panel for one selected graph node. Shows the optional
 * `description`, `next_action`, and `references` fields when they're present
 * (per SCHEMA.md they're absent on some nodes — render only what we have).
 * The "Open thread" button navigates to the chat thread that produced this
 * node, using the existing `?threadId=` query param (clearing `view` so the
 * chat UI re-mounts).
 */
export function SparkNodeDetail({ node, onClose }: SparkNodeDetailProps) {
  const [, setThreadId] = useQueryState("threadId");
  const [, setView] = useQueryState("view");
  const [copied, setCopied] = useState(false);
  const threadIdLooksValid = looksLikeThreadId(node.thread_id);

  // Reset the "copied" affordance whenever the selected node changes — so
  // switching nodes after a copy doesn't leave a stale check icon.
  useEffect(() => setCopied(false), [node.id]);

  const openThread = () => {
    void setThreadId(node.thread_id);
    void setView(null);
  };

  const copyThreadId = async () => {
    const ok = await copyText(node.thread_id);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <aside
      aria-label="Node details"
      className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-background"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Idea
          </div>
          <h3 className="mt-0.5 break-words text-base font-semibold leading-snug">
            {node.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close node details"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X
            className="size-4"
            aria-hidden="true"
          />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {node.description && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </h4>
            <p className="whitespace-pre-wrap leading-relaxed text-foreground">
              {node.description}
            </p>
          </section>
        )}
        {node.next_action && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Next action
            </h4>
            <p className="whitespace-pre-wrap leading-relaxed text-foreground">
              {node.next_action}
            </p>
          </section>
        )}
        {node.references && node.references.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              References
            </h4>
            <ul className="space-y-1">
              {node.references.map((ref) => {
                const resolved = resolveReference(ref);
                return (
                  <li
                    key={ref}
                    className="break-all"
                  >
                    {resolved.href ? (
                      <a
                        href={resolved.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {resolved.label}
                      </a>
                    ) : (
                      <span className="text-foreground">{resolved.label}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Originating thread
          </h4>
          <div className="flex items-center gap-1.5">
            <code className="bg-surface min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 font-mono text-xs text-muted-foreground">
              {node.thread_id}
            </code>
            <button
              type="button"
              onClick={copyThreadId}
              aria-label={copied ? "Thread id copied" : "Copy thread id"}
              title="Copy thread id"
              className={cn(
                "rounded p-1.5 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                copied ? "text-[var(--brand)]" : "text-muted-foreground"
              )}
            >
              {copied ? (
                <Check
                  className="size-3.5"
                  aria-hidden="true"
                />
              ) : (
                <Copy
                  className="size-3.5"
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        </section>
      </div>
      <footer className="flex-shrink-0 border-t border-border px-4 py-3">
        <Button
          onClick={openThread}
          disabled={!threadIdLooksValid}
          title={
            threadIdLooksValid
              ? undefined
              : "This node's thread id is not a LangGraph UUID — the skill recorded a different identifier and the backend can't open it."
          }
          className="w-full justify-center gap-2"
        >
          Open thread
          <ArrowRight
            className="size-4"
            aria-hidden="true"
          />
        </Button>
      </footer>
    </aside>
  );
}
