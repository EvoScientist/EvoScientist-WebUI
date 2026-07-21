import useSWRInfinite from "swr/infinite";
import type { Thread } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk";
import { getConfig } from "@/lib/config";
import { patchClientStreamModes } from "@/lib/streamMode";
import {
  buildThreadLabelPatch,
  needsThreadLabelBackfill,
} from "@/lib/threadLabels";

export interface ThreadItem {
  id: string;
  updatedAt: Date;
  status: Thread["status"];
  title: string;
  description: string;
  assistantId?: string;
  pinned: boolean;
  /** True when any of the thread's pending interrupts is an `ask_user` —
   *  i.e. the agent is asking the user a question that auto-approve can't
   *  resolve. Used by the sidebar to keep these threads in "Requiring
   *  Attention" even when auto-approve is on. */
  needsUserInput: boolean;
}

const DEFAULT_PAGE_SIZE = 20;

const labelBackfillAttempted = new Map<string, string>();

async function backfillThreadLabels(
  client: Client,
  id: string,
  attemptKey: string,
  attemptedState: string
): Promise<{ autoTitle: string | null; preview: string | null } | null> {
  try {
    const thread = await client.threads.get(id);
    const values = thread.values as { messages?: unknown } | undefined;
    const derived = deriveThreadMetadata(values?.messages);
    const current = (thread.metadata ?? {}) as Record<string, unknown>;
    const stateUpdatedAt =
      (thread as { state_updated_at?: string | null }).state_updated_at ||
      thread.updated_at;
    const patch = buildThreadLabelPatch(current, derived, stateUpdatedAt);
    if (Object.keys(patch).length > 0) {
      await client.threads.update(id, { metadata: { ...current, ...patch } });
    }
    return derived;
  } catch {
    // Do not clear a newer attempt if this older request fails after the
    // thread has already advanced again.
    if (labelBackfillAttempted.get(attemptKey) === attemptedState) {
      labelBackfillAttempted.delete(attemptKey);
    }
    return null;
  }
}

export function useThreads(props: {
  status?: Thread["status"];
  limit?: number;
}) {
  const pageSize = props.limit || DEFAULT_PAGE_SIZE;

  return useSWRInfinite(
    (pageIndex: number, previousPageData: ThreadItem[] | null) => {
      const config = getConfig();
      const apiKey =
        config?.langsmithApiKey ||
        process.env.NEXT_PUBLIC_LANGSMITH_API_KEY ||
        "";

      if (!config) {
        return null;
      }

      // If the previous page returned no items, we've reached the end
      if (previousPageData && previousPageData.length === 0) {
        return null;
      }

      return {
        kind: "threads" as const,
        pageIndex,
        pageSize,
        deploymentUrl: config.deploymentUrl,
        assistantId: config.assistantId,
        apiKey,
        status: props?.status,
      };
    },
    async ({
      deploymentUrl,
      assistantId,
      apiKey,
      status,
      pageIndex,
      pageSize,
    }: {
      kind: "threads";
      pageIndex: number;
      pageSize: number;
      deploymentUrl: string;
      assistantId: string;
      apiKey: string;
      status?: Thread["status"];
    }) => {
      const client = patchClientStreamModes(
        new Client({
          apiUrl: deploymentUrl,
          defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
        })
      );

      // Always scope the thread list to the selected assistant so we never
      // show threads spawned by async sub-agents (e.g. writing-agent,
      // data-analysis-agent) that share the same deployment store.
      //
      // Every thread carries both `graph_id` (the graph name) and
      // `assistant_id` (a deterministic UUID per graph) in its metadata.
      // A deployed UUID is matched against `assistant_id`; a graph name
      // (the local-dev case, e.g. "EvoScientist") is matched against
      // `graph_id`.
      const isUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          assistantId
        );
      const metadata = isUUID
        ? { assistant_id: assistantId }
        : { graph_id: assistantId };

      // Sort by state_updated_at (last checkpoint write, i.e. last actual
      // chat activity) rather than updated_at. Any metadata patch
      // (rename/pin/preview writeback/backfill script) bumps updated_at,
      // which would resurface stale threads at the top of the list.
      // state_updated_at only advances on genuine graph state changes.
      //
      // Sidebar payload minimization: never fetch `values` (full message
      // history, easily tens of MB across a page). Title and description
      // come from precomputed keys in `metadata` that `useChat` writes back
      // after each turn (`auto_title`, `preview`), plus the user rename
      // (`title`) and pinned flag already stored there. Threads missing both
      // keys (pre-fix threads, or threads created by CLI/TUI surfaces) are
      // self-healed below: fetched individually once, derived, written back.
      //
      // Backends too old to know `select` / `state_updated_at` may reject the
      // request — fall back to the legacy query (full values, updated_at
      // sort) and derive labels inline so the sidebar still renders.
      const baseSearch = {
        limit: pageSize,
        offset: pageIndex * pageSize,
        sortOrder: "desc" as const,
        status,
        metadata,
      };
      let threads: Awaited<ReturnType<typeof client.threads.search>>;
      let legacySearch = false;
      try {
        threads = await client.threads.search({
          ...baseSearch,
          sortBy: "state_updated_at" as const,
          select: [
            "thread_id",
            "updated_at",
            "state_updated_at",
            "status",
            "metadata",
            "interrupts",
          ],
        });
      } catch {
        legacySearch = true;
        threads = await client.threads.search({
          ...baseSearch,
          sortBy: "updated_at" as const,
        });
      }

      const items = await Promise.all(
        threads.map(async (thread): Promise<ThreadItem> => {
          const md = (thread.metadata ?? {}) as Record<string, unknown>;
          // A user rename (stored under `title`) always wins over the derived
          // auto-title so the sidebar reflects what the user typed.
          const customTitle =
            typeof md.title === "string" ? md.title.trim() : "";
          let autoTitle =
            typeof md.auto_title === "string" ? md.auto_title.trim() : "";
          let preview = typeof md.preview === "string" ? md.preview.trim() : "";
          // Prefer state_updated_at (real chat activity) but fall back to
          // updated_at for very old threads that predate the field.
          const activityTs =
            (thread as { state_updated_at?: string | null }).state_updated_at ||
            thread.updated_at;

          if (needsThreadLabelBackfill(md, activityTs)) {
            if (legacySearch) {
              const derived = deriveThreadMetadata(
                (thread.values as { messages?: unknown } | undefined)?.messages
              );
              autoTitle = autoTitle || (derived.autoTitle ?? "");
              preview = preview || (derived.preview ?? "");
            } else {
              const attemptKey = `${deploymentUrl}\u0000${thread.thread_id}`;
              if (labelBackfillAttempted.get(attemptKey) !== activityTs) {
                labelBackfillAttempted.set(attemptKey, activityTs);
                const derived = await backfillThreadLabels(
                  client,
                  thread.thread_id,
                  attemptKey,
                  activityTs
                );
                if (derived) {
                  autoTitle = autoTitle || (derived.autoTitle ?? "");
                  preview = preview || (derived.preview ?? "");
                }
              }
            }
          }

          // Title falls back to the first-human autoTitle, then to the AI
          // preview (rare edge case: attachment-only human message with no
          // text), then to a bare thread-id label so nothing renders as
          // "Untitled Thread".
          let title = customTitle || autoTitle;
          if (!title && preview) title = preview;
          if (!title) title = `Thread ${thread.thread_id.slice(0, 8)}`;
          if (title.length > 50) title = title.slice(0, 50) + "…";

          const description =
            preview.length > 100 ? preview.slice(0, 100) : preview;

          // Pinned state is stored in thread metadata (like the custom title),
          // so it persists across reloads/devices via the backend store.
          const pinned = md.pinned === true;

          // Walk `thread.interrupts` (Record<task_id, Interrupt[]>) and flag
          // any value with `type: "ask_user"`. The auto-approver can't resolve
          // those, so the sidebar should keep the row in "Requiring Attention"
          // even when auto-approve is on for the thread.
          let needsUserInput = false;
          const interrupts = thread.interrupts as
            | Record<string, Array<{ value?: unknown }>>
            | undefined;
          if (interrupts && typeof interrupts === "object") {
            for (const list of Object.values(interrupts)) {
              if (!Array.isArray(list)) continue;
              for (const ir of list) {
                const value = ir?.value as { type?: unknown } | undefined;
                if (value && value.type === "ask_user") {
                  needsUserInput = true;
                  break;
                }
              }
              if (needsUserInput) break;
            }
          }

          return {
            id: thread.thread_id,
            updatedAt: new Date(activityTs),
            status: thread.status,
            title,
            description,
            assistantId,
            pinned,
            needsUserInput,
          };
        })
      );
      return items;
    },
    {
      revalidateFirstPage: true,
      revalidateOnFocus: true,
    }
  );
}

// --- Thread mutations (used by the thread list's rename / delete actions) ---

function makeThreadsClient(): Client | null {
  const config = getConfig();
  if (!config) return null;
  const apiKey =
    config.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
  return patchClientStreamModes(
    new Client({
      apiUrl: config.deploymentUrl,
      defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
    })
  );
}

/** Permanently delete a thread. Throws if no deployment is configured. */
export async function deleteThread(id: string): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  await client.threads.delete(id);
}

async function updateThreadMetadata(
  client: Client,
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const thread = await client.threads.get(id);
  const metadata = {
    ...((thread.metadata as Record<string, unknown> | undefined) ?? {}),
    ...patch,
  };
  await client.threads.update(id, { metadata });
}

/**
 * Rename a thread by storing a custom title in its metadata. The LangGraph
 * thread PATCH replaces metadata, so read + merge first to preserve graph_id /
 * assistant_id filter keys.
 */
export async function renameThread(id: string, title: string): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  await updateThreadMetadata(client, id, { title });
}

/**
 * Pin or unpin a thread by storing a `pinned` flag in its metadata. Preserve
 * the rest of the metadata for the same reason as `renameThread`.
 */
export async function pinThread(id: string, pinned: boolean): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  await updateThreadMetadata(client, id, { pinned });
}

/**
 * Persist (or clear) the per-thread model override. Pass `null` to remove the
 * key so the thread reverts to the deployment-default model. Reads on
 * subsequent runs flow through `useChat` → `stream.submit({ config: ... })`,
 * which the backend's `configurable_model` middleware resolves per request.
 */
export async function setThreadModelOverride(
  id: string,
  override: { model: string; model_provider?: string } | null
): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  // Passing `null` here keeps the key present in metadata but explicitly
  // un-set, which matches how langgraph treats absence-vs-null in the
  // configurable middleware (`getattr(cfg, "model", None)` accepts both).
  await updateThreadMetadata(client, id, { model_override: override });
}

/**
 * Derive the two thread-sidebar labels — a "auto_title" from the first human
 * message and a "preview" from the first AI message with actual text — off a
 * message list. Same textOf shape as the original `useThreads` mapping (string
 * OR content-block array). Returns `null` for either slot when there is
 * nothing usable, so callers can leave the corresponding metadata key alone.
 *
 * Kept caps small on purpose: metadata rows are indexed and re-fetched on
 * every sidebar load, so shorter is strictly better.
 */
export function deriveThreadMetadata(messages: unknown): {
  autoTitle: string | null;
  preview: string | null;
} {
  const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((p) => {
          if (p && typeof p === "object") {
            const t = (p as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          }
          return "";
        })
        .join("");
    return "";
  };
  const list = Array.isArray(messages)
    ? (messages as Array<{ type?: unknown; content?: unknown }>)
    : [];
  let autoTitle: string | null = null;
  let preview: string | null = null;
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (autoTitle === null && m.type === "human") {
      const t = textOf(m.content).trim();
      if (t) autoTitle = t.slice(0, 100);
    }
    if (preview === null && m.type === "ai") {
      const t = textOf(m.content).trim();
      if (t) preview = t.slice(0, 200);
    }
    if (autoTitle !== null && preview !== null) break;
  }
  return { autoTitle, preview };
}

/**
 * Write derived sidebar labels into thread metadata, only for keys that would
 * actually change. Read + merge preserves other metadata keys (custom title,
 * pinned, model_override, graph_id / assistant_id filter keys). Silent no-op
 * when no client is configured or nothing needs writing — this runs in a
 * fire-and-forget effect and must never throw into the render tree.
 */
export async function persistThreadDerivedMetadata(
  id: string,
  next: { autoTitle: string | null; preview: string | null }
): Promise<void> {
  const client = makeThreadsClient();
  if (!client) return;
  const thread = await client.threads.get(id);
  const current = (thread.metadata ?? {}) as Record<string, unknown>;
  const stateUpdatedAt =
    (thread as { state_updated_at?: string | null }).state_updated_at ||
    thread.updated_at;
  const patch = buildThreadLabelPatch(current, next, stateUpdatedAt);
  if (Object.keys(patch).length === 0) return;
  await client.threads.update(id, { metadata: { ...current, ...patch } });
}

// Strip characters that are unsafe in filenames on Windows/macOS/Linux, then
// collapse whitespace. Keep this lenient — we just need a valid filename, not
// a slug.
function slugifyForFilename(input: string): string {
  return (
    input
      // Stripping control chars is the point — silence the lint rule.
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80)
  );
}

/**
 * Download the full thread state as JSON. We fetch via `client.threads.get`
 * which returns the thread plus its current `values` (every message including
 * tool calls, sub-agent output, and assistant thinking) — i.e. everything the
 * backend has, suitable for debugging.
 */
export async function exportThread(
  id: string,
  filenameHint?: string
): Promise<void> {
  const client = makeThreadsClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  const thread = await client.threads.get(id);
  const blob = new Blob([JSON.stringify(thread, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const safeName =
    (filenameHint && slugifyForFilename(filenameHint)) ||
    `thread-${id.slice(0, 8)}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer URL revocation a tick so Safari/Firefox finish the download trigger.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
