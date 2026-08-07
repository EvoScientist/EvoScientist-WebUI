"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { DEFAULT_ASSISTANT_ID } from "@/lib/config";
import { useClient } from "@/providers/ClientProvider";
import { cn } from "@/lib/utils";
import {
  buildElaborateTriggerMessage,
  rejectCascade,
  restoreCascade,
  SPARK_PREFILL_EVENT,
  SPARK_PREFILL_STORAGE_PREFIX,
  SparkGraphLockedError,
  threadIdToColorRgba,
  writeSparkGraph,
  type SparkGraph,
  type SparkNode,
  type SparkPrefillEventDetail,
} from "@/lib/sparkTypes";

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
  graph: SparkGraph;
  onClose: () => void;
  /** Fired after a successful Reject/Restore — parent re-fetches graph.json. */
  onGraphUpdated: () => void;
}

/**
 * Right-side detail panel for one selected graph node. Shows the optional
 * `description`, `next_action`, and `references` fields when they're present
 * (per SCHEMA.md they're absent on some nodes — render only what we have).
 * The "Open thread" button navigates to the chat thread that produced this
 * node, using the existing `?threadId=` query param (clearing `view` so the
 * chat UI re-mounts).
 */
export function SparkNodeDetail({
  node,
  graph,
  onClose,
  onGraphUpdated,
}: SparkNodeDetailProps) {
  const [, setThreadId] = useQueryState("threadId");
  const [, setView] = useQueryState("view");
  const client = useClient();
  const [copied, setCopied] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [newChatBusy, setNewChatBusy] = useState(false);
  const threadIdLooksValid = looksLikeThreadId(node.thread_id);
  const isRejected = node.rejected === true;

  // Reset the "copied" affordance whenever the selected node changes — so
  // switching nodes after a copy doesn't leave a stale check icon.
  useEffect(() => setCopied(false), [node.id]);

  const openThread = () => {
    void setThreadId(node.thread_id);
    void setView(null);
  };

  // Drop the contract-templated trigger message into the node's originating
  // thread via the localStorage handshake `ChatInterface` listens on, then
  // route to that thread and dismiss the spark panel. We deliberately send
  // it to `node.thread_id` (not `currentThreadId`) so the elaboration lands
  // where the idea was born — that's the chat the user expects to "continue"
  // and the one the skill keys on. We do NOT auto-send — per contract the
  // user submits (and may edit, e.g. to add stage-5 keywords).
  const elaborateNextAction = () => {
    window.localStorage.setItem(
      `${SPARK_PREFILL_STORAGE_PREFIX}${node.thread_id}`,
      buildElaborateTriggerMessage(node, graph)
    );
    void setThreadId(node.thread_id);
    void setView(null);
    // Tell ChatInterface to consume the prefill now. Necessary since chat
    // stays mounted across view switches — a same-thread elaborate doesn't
    // change `threadId`, so the threadId-keyed effect alone wouldn't fire.
    window.dispatchEvent(
      new CustomEvent<SparkPrefillEventDetail>(SPARK_PREFILL_EVENT, {
        detail: { threadId: node.thread_id },
      })
    );
  };

  const copyThreadId = async () => {
    const ok = await copyText(node.thread_id);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  // Reject or restore this node and its subtree, write the new graph.json back
  // through the existing memory API, then ask the parent to re-fetch so the
  // change shows up immediately. Errors surface via toast — the optimistic
  // approach would be cleaner but we'd need to teach useSparkGraph to accept
  // patches, and Phase 2 doesn't need that yet.
  const toggleRejection = async () => {
    if (rejectBusy) return;
    setRejectBusy(true);
    try {
      const next = isRejected
        ? restoreCascade(graph, node.id)
        : rejectCascade(graph, node.id);
      await writeSparkGraph(next);
      onGraphUpdated();
    } catch (err) {
      // Locked-by-skill is the expected race, not a "save failed" — surface
      // the message as-is so the user sees a hint, not a "Couldn't save:" prefix.
      if (err instanceof SparkGraphLockedError) {
        toast.error(err.message);
      } else {
        toast.error(
          err instanceof Error
            ? `Couldn't save: ${err.message}`
            : "Couldn't save the change — try again."
        );
      }
    } finally {
      setRejectBusy(false);
    }
  };

  // Create a fresh LangGraph thread anchored back to this node, then jump
  // into it. Metadata carries:
  //   - `graph_id`: the assistant/graph filter the thread list searches on —
  //     without it the new thread wouldn't show up in the sidebar.
  //   - `idea_spark_graph_id` / `idea_spark_parent_node_id`: the Phase 3
  //     breadcrumb the skill (and a future chat-side breadcrumb) reads to
  //     know which graph and which node this conversation is exploring.
  //   - `idea_spark_node_snapshot`: a point-in-time copy of the node's
  //     human-readable fields (title / description / next_action /
  //     references). The agent reads it on the first turn instead of
  //     re-deriving the same context from graph.json, cutting recovery cost
  //     from ~12 turns down to one. Snapshot only — if the graph changes
  //     later the skill should re-fetch graph.json via
  //     `idea_spark_parent_node_id`.
  // No composer prefill in v1 — the user types their own opening message.
  const startNewChat = async () => {
    if (newChatBusy) return;
    setNewChatBusy(true);
    try {
      // Build the snapshot from the fields actually present on the node — the
      // schema's optional fields can legitimately be absent and we don't want
      // to ship empty strings or empty arrays that look like real data.
      const snapshot: Record<string, unknown> = { title: node.title };
      if (node.description) snapshot.description = node.description;
      if (node.next_action) snapshot.next_action = node.next_action;
      if (node.references && node.references.length > 0) {
        snapshot.references = node.references;
      }
      const newThread = await client.threads.create({
        metadata: {
          graph_id: DEFAULT_ASSISTANT_ID,
          // `title` is picked up by useThreads.ts's sidebar-title pipeline
          // (it takes precedence over the derived-from-first-message default),
          // so the thread shows up labelled by the idea instead of "Untitled".
          title: node.title,
          idea_spark_graph_id: graph.id,
          idea_spark_parent_node_id: node.id,
          idea_spark_node_snapshot: snapshot,
        },
      });
      void setThreadId(newThread.thread_id);
      void setView(null);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Couldn't start a new chat: ${err.message}`
          : "Couldn't start a new chat — try again."
      );
    } finally {
      setNewChatBusy(false);
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
            <span
              aria-hidden="true"
              title="Thread provenance colour"
              className="size-3 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: threadIdToColorRgba(node.thread_id) }}
            />
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
      <footer className="flex flex-shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        {(() => {
          const elaborateDisabledReason = isRejected
            ? "Rejected directions are not elaborated."
            : !node.next_action
            ? "This node has no next action to elaborate on."
            : !threadIdLooksValid
            ? "This node's thread id is not a LangGraph UUID — the backend can't route there."
            : null;
          return (
            <>
              <Button
                onClick={elaborateNextAction}
                disabled={elaborateDisabledReason !== null}
                title={
                  elaborateDisabledReason ??
                  "Pre-fill the originating thread's chat with a trigger message for the idea-elaborate skill."
                }
                className="w-full justify-center gap-2"
              >
                <Sparkles
                  className="size-4"
                  aria-hidden="true"
                />
                Elaborate next action
              </Button>
              {elaborateDisabledReason === null && (
                <p className="text-xs text-muted-foreground">
                  Edit the message to add &quot;draft a paper&quot; for a full
                  manuscript.
                </p>
              )}
            </>
          );
        })()}
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
        <Button
          variant="outline"
          onClick={startNewChat}
          disabled={newChatBusy}
          title="Create a new chat anchored to this idea. The skill can extend the graph from this node on its next run."
          className="w-full justify-center gap-2"
        >
          {newChatBusy ? (
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <MessageSquarePlus
              className="size-4"
              aria-hidden="true"
            />
          )}
          New chat from this idea
        </Button>
        <Button
          variant={isRejected ? "secondary" : "outline"}
          onClick={toggleRejection}
          disabled={rejectBusy}
          title={
            isRejected
              ? "Restore this idea and its descendants."
              : "Reject this idea and its descendants — the agent will deprioritise this branch on the next run."
          }
          className="w-full justify-center gap-2"
        >
          {rejectBusy ? (
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
          ) : isRejected ? (
            <RotateCcw
              className="size-4"
              aria-hidden="true"
            />
          ) : (
            <X
              className="size-4"
              aria-hidden="true"
            />
          )}
          {isRejected ? "Restore" : "Reject"}
        </Button>
      </footer>
    </aside>
  );
}
