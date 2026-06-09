"use client";

import { useCallback, useEffect, useState } from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import { type Message, type Assistant } from "@langchain/langgraph-sdk";
import { v4 as uuidv4 } from "uuid";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";
import type { TodoItem } from "@/app/types/types";
import { useClient } from "@/providers/ClientProvider";
import { useQueryState } from "nuqs";
import {
  extractSubAgentSteps,
  type SubAgentStep,
} from "@/lib/subAgentActivity";

export type StateType = {
  messages: Message[];
  todos: TodoItem[];
  files: Record<string, string>;
  email?: {
    id?: string;
    subject?: string;
    page_content?: string;
  };
  // Background async sub-agents (writing-agent / data-analysis-agent) this
  // conversation launched, keyed by task_id. Shape = deepagents' AsyncTask.
  async_tasks?: Record<string, unknown>;
  ui?: any;
};

/**
 * Sanitize a raw interrupt pulled from `client.threads.getState` before it is
 * surfaced to the UI. The live SDK normalizes `stream.interrupt`, but the raw
 * persisted task interrupt is unvalidated — if its `value.action_requests`
 * (or `review_configs`) is present but NOT an array, ChatInterface's
 * `actionRequests.map(...)` / `for (const rc of review_configs)` throws and
 * blanks the entire page (the hard crash seen when deleting a file). Require an
 * object with an object `value`, and coerce any malformed list field to `[]` so
 * the worst case is "no card" instead of a render crash.
 */
function normalizePendingInterrupt(
  pending: unknown
): { value: Record<string, unknown> } | undefined {
  if (!pending || typeof pending !== "object") return undefined;
  const value = (pending as { value?: unknown }).value;
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const normalizedValue: Record<string, unknown> = { ...v };
  if ("action_requests" in v && !Array.isArray(v.action_requests)) {
    normalizedValue.action_requests = [];
  }
  if ("review_configs" in v && !Array.isArray(v.review_configs)) {
    normalizedValue.review_configs = [];
  }
  // Preserve the interrupt's other fields (id, ns, …); only the value is fixed.
  return { ...(pending as object), value: normalizedValue } as {
    value: Record<string, unknown>;
  };
}

/**
 * Total visible text length across a message list. Used to detect when the live
 * stream dropped tail CONTENT without dropping the message COUNT — e.g. the
 * final assistant turn arrives as an empty/partial AI message (same count) while
 * the persisted server snapshot has the full text. A pure length compare misses
 * that; comparing total text catches it.
 */
function totalTextLength(msgs: Message[]): number {
  let n = 0;
  for (const m of msgs) {
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") {
      n += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        const t = (part as { text?: unknown })?.text;
        if (typeof t === "string") n += t.length;
      }
    }
  }
  return n;
}

/**
 * A content key for an interrupt, used to tell "the stale interrupt the server
 * already resolved" apart from "a genuinely new interrupt". We key on the
 * `value` payload because both the live SDK interrupt and the getState-fetched
 * one share it (and a fresh object identity each poll can't be compared).
 */
function interruptValueKey(i: unknown): string | null {
  if (!i || typeof i !== "object") return null;
  try {
    return JSON.stringify((i as { value?: unknown }).value ?? null);
  } catch {
    return null;
  }
}

export function useChat({
  activeAssistant,
  onHistoryRevalidate,
  thread,
}: {
  activeAssistant: Assistant | null;
  onHistoryRevalidate?: () => void;
  thread?: UseStreamThread<StateType>;
}) {
  const [threadId, setThreadId] = useQueryState("threadId");
  const client = useClient();

  // Live sub-agent activity captured from subgraph stream events, keyed by the
  // subgraph namespace (e.g. "tools:<id>"). Ephemeral: it resets when the chat
  // session remounts on thread switch, and is not persisted (lost on reload).
  const [subAgentActivity, setSubAgentActivity] = useState<
    Record<string, SubAgentStep[]>
  >({});

  const stream = useStream<StateType>({
    assistantId: activeAssistant?.assistant_id || "",
    client: client ?? undefined,
    reconnectOnMount: true,
    threadId: threadId ?? null,
    onThreadId: setThreadId,
    defaultHeaders: { "x-auth-scheme": "langsmith" },
    // Enable fetching state history when switching to existing threads
    fetchStateHistory: true,
    // Revalidate thread list when stream finishes, errors, or creates new thread
    onFinish: onHistoryRevalidate,
    onError: onHistoryRevalidate,
    onCreated: onHistoryRevalidate,
    // Capture sub-agent (subgraph) node outputs as they stream. `namespace` is
    // non-empty (e.g. ["tools:<id>"]) for subgraphs and empty for the main graph,
    // which we skip.
    onUpdateEvent: (data, options) => {
      const ns = options?.namespace;
      if (!ns || ns.length === 0) return;
      const steps = extractSubAgentSteps(data);
      if (steps.length === 0) return;
      const key = ns.join("|");
      setSubAgentActivity((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), ...steps],
      }));
    },
    experimental_thread: thread,
  });

  // --- Resilient pending-state fallback ------------------------------------
  // The live SSE stream can end (isLoading flips false) BEFORE the run actually
  // pauses on a tool-approval interrupt server-side — e.g. the backend's
  // auxiliary tool-selector model emits into the stream and desyncs it. When
  // that happens, `stream.interrupt` stays empty AND `stream.messages` is stale
  // (missing the final `execute` tool-call message), so the approval card never
  // renders until a manual thread switch re-fetches history.
  //
  // Bridge it by reading thread state directly once the stream settles: while
  // the run is still pending (`next` non-empty) but no live interrupt is shown,
  // poll a BOUNDED number of times until the interrupt is persisted, then
  // surface BOTH the interrupt and that snapshot's messages. Stops as soon as
  // the interrupt is found or the run is truly done (`next` empty); a new run
  // (isLoading→true) clears it. Not an unbounded poll — that would race the
  // live stream and revive resolved interrupts.
  const [fetchedInterrupt, setFetchedInterrupt] =
    useState<typeof stream.interrupt>(undefined);
  // Content key of an interrupt the server confirmed RESOLVED. The getter
  // suppresses a stale `stream.interrupt` (e.g. one re-surfaced from SDK history
  // after approving) ONLY when it matches this key — so a genuinely new
  // interrupt is never hidden (the old global-null sentinel hid everything).
  const [resolvedInterruptKey, setResolvedInterruptKey] = useState<
    string | null
  >(null);
  const [fetchedMessages, setFetchedMessages] = useState<Message[] | null>(
    null
  );
  useEffect(() => {
    if (!threadId) {
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setResolvedInterruptKey(null);
      return;
    }
    // The live stream count at the moment it settled. If the server's persisted
    // state has MORE messages than this, the stream ended early and dropped the
    // tail — either the final assistant text, or the `execute` tool-call message
    // plus its approval interrupt. Either way we backfill from thread state
    // (the same data a thread-switch re-fetch would pull in).
    const baseline = stream.messages.length;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const MAX_TRIES = 15;
    const attempt = async () => {
      tries += 1;
      try {
        const state = (await client.threads.getState(threadId)) as {
          tasks?: Array<{ interrupts?: unknown[] }>;
          next?: unknown[];
          values?: { messages?: Message[] };
        };
        if (cancelled) return;
        const msgs = state.values?.messages;
        const interrupts = state.tasks?.at(-1)?.interrupts;
        const pending: unknown =
          Array.isArray(interrupts) && interrupts.length > 0
            ? interrupts[interrupts.length - 1]
            : undefined;
        const stillPending = Array.isArray(state.next) && state.next.length > 0;
        // Backfill whenever the server is ahead of what the stream delivered.
        if (Array.isArray(msgs) && msgs.length > baseline) {
          setFetchedMessages(msgs);
        }
        const safePending = normalizePendingInterrupt(pending);
        if (safePending) {
          // Tool-approval interrupt reached — surface it (+ messages) and stop.
          // There IS a live pending interrupt, so drop any stale suppression.
          setFetchedInterrupt(
            safePending as unknown as typeof stream.interrupt
          );
          setResolvedInterruptKey(null);
          if (Array.isArray(msgs)) setFetchedMessages(msgs);
          return;
        }
        if (!stillPending) {
          // The server has no pending task/interrupt anymore. Record the stale
          // live interrupt's identity so the getter suppresses ONLY that one
          // (composer unlocks after approving) — a new interrupt still shows.
          setFetchedInterrupt(undefined);
          setResolvedInterruptKey(interruptValueKey(stream.interrupt));
          if (Array.isArray(msgs)) setFetchedMessages(msgs);
          return;
        }
        // Keep polling only while the run is still working server-side; a
        // finished run (next empty) won't produce anything more.
        if (stillPending && tries < MAX_TRIES && !cancelled) {
          timer = setTimeout(attempt, 1000);
        }
      } catch {
        if (!cancelled && tries < MAX_TRIES) timer = setTimeout(attempt, 1000);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Precise deps on purpose: re-running on the whole `stream` object (new each
    // render) would loop the getState fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, stream.interrupt, stream.isLoading, client]);

  // Show the live interrupt unless it's the exact one the server told us was
  // resolved (then fall through to the fetched one, usually undefined → composer
  // unlocks). A new live interrupt has a different key, so it's never suppressed.
  const liveInterrupt = stream.interrupt;
  const interrupt =
    liveInterrupt &&
    (resolvedInterruptKey === null ||
      interruptValueKey(liveInterrupt) !== resolvedInterruptKey)
      ? liveInterrupt
      : fetchedInterrupt ?? undefined;
  // Prefer the backfilled snapshot when it is "ahead" of the live stream — i.e.
  // the stream ended early and dropped the tail. "Ahead" means either MORE
  // messages, or (once settled) the SAME number of messages but MORE total text:
  // the final assistant turn often arrives as an empty/partial AI message with
  // the right count but no content, so a pure length compare would keep showing
  // the blank live version (the bug where the answer only appears after a manual
  // refresh). The equal-count/more-text rule is gated on `!isLoading` so a
  // mid-stream poll snapshot never flickers over the actively updating stream.
  const messages = (() => {
    if (!fetchedMessages) return stream.messages;
    if (fetchedMessages.length > stream.messages.length) return fetchedMessages;
    if (
      !stream.isLoading &&
      fetchedMessages.length === stream.messages.length &&
      totalTextLength(fetchedMessages) > totalTextLength(stream.messages)
    ) {
      return fetchedMessages;
    }
    return stream.messages;
  })();

  const sendMessage = useCallback(
    (content: string) => {
      // Drop any settled-run snapshot up front. Otherwise, until `isLoading`
      // flips true (and the effect above clears it), a previous run's
      // `fetchedMessages` can still out-count `stream.messages` and shadow the
      // just-added optimistic user message — making it flicker/vanish.
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setResolvedInterruptKey(null);
      const newMessage: Message = { id: uuidv4(), type: "human", content };
      stream.submit(
        { messages: [newMessage] },
        {
          optimisticValues: (prev) => ({
            messages: [...(prev.messages ?? []), newMessage],
          }),
          config: { ...(activeAssistant?.config ?? {}), recursion_limit: 100 },
          streamSubgraphs: true,
          streamMode: ["updates"],
          streamResumable: true,
          onDisconnect: "continue",
        }
      );
      // Update thread list immediately when sending a message
      onHistoryRevalidate?.();
    },
    [stream, activeAssistant?.config, onHistoryRevalidate]
  );

  const setFiles = useCallback(
    async (files: Record<string, string>) => {
      if (!threadId) return;
      // TODO: missing a way how to revalidate the internal state
      // I think we do want to have the ability to externally manage the state
      await client.threads.updateState(threadId, { values: { files } });
    },
    [client, threadId]
  );

  const resumeInterrupt = useCallback(
    (value: any) => {
      // Same as sendMessage: clear the prior snapshot before resuming so a stale
      // fetchedInterrupt/fetchedMessages can't briefly re-surface a resolved
      // approval card or shadow the resumed run's messages.
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setResolvedInterruptKey(null);
      stream.submit(null, {
        command: { resume: value },
        streamSubgraphs: true,
        streamMode: ["updates"],
        streamResumable: true,
        onDisconnect: "continue",
      });
      // Update thread list when resuming from interrupt
      onHistoryRevalidate?.();
    },
    [stream, onHistoryRevalidate]
  );

  const stopStream = useCallback(() => {
    stream.stop();
  }, [stream]);

  return {
    stream,
    todos: stream.values.todos ?? [],
    files: stream.values.files ?? {},
    email: stream.values.email,
    asyncTasks: stream.values.async_tasks ?? {},
    ui: stream.values.ui,
    setFiles,
    messages,
    isLoading: stream.isLoading,
    isThreadLoading: stream.isThreadLoading,
    interrupt,
    sendMessage,
    stopStream,
    resumeInterrupt,
    subAgentActivity,
  };
}
