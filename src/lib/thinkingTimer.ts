// How long a model thought before it started answering. The backend doesn't
// record it, so useChat times it from the live stream, and only where it saw
// all of it: in a run started on this page, from the first update with the
// reply (some models reason without streaming text) to the one where its
// answer or a tool call starts. A reply joined mid-thought (a reload, a thread
// opened again), or stopped, failed or cut before it answered, has no time.
// Times are kept by message id for the page's life, whatever renders the reply.

import { useSyncExternalStore } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import {
  extractStringFromMessageContent,
  getMessageToolCalls,
} from "@/app/utils/utils";

const MAX_KEPT = 500;
const times = new Map<string, number>();
const listeners = new Set<() => void>();

function record(id: string, seconds: number) {
  times.set(id, seconds);
  if (times.size > MAX_KEPT) times.delete(times.keys().next().value!);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whole seconds the reply thought, or null when it has no time. */
export function thoughtSeconds(id: string | undefined): number | null {
  return id === undefined ? null : times.get(id) ?? null;
}

/** `thoughtSeconds`, rendering again once the time is recorded. */
export function useThoughtSeconds(id: string | undefined): number | null {
  return useSyncExternalStore(
    subscribe,
    () => thoughtSeconds(id),
    () => null
  );
}

// The answer or a tool call has started, as the chat shows them.
function replyStarted(message: Message): boolean {
  return (
    extractStringFromMessageContent(message).trim() !== "" ||
    getMessageToolCalls(message).length > 0
  );
}

// A response's first chunk, with nothing in it yet. OpenAI's Responses API
// (direct, and ChatGPT sign-in) gives only that chunk (response.created) the
// response's id, in `id` and `response_metadata.id`; langchain gives the rest
// its run id. So the SDK streams the reply as this empty message followed by
// the rest, and the saved reply keeps the response's id: one reply, timed
// under both ids.
function isResponseHead(
  message: Message | undefined
): message is Message & { id: string } {
  if (message?.type !== "ai" || !message.id) return false;
  const { content } = message;
  const metadata = message.response_metadata as
    | Record<string, unknown>
    | undefined;
  return (
    metadata?.id === message.id &&
    (!content || (Array.isArray(content) && content.length === 0)) &&
    getMessageToolCalls(message).length === 0
  );
}

/** The provider and model that streamed a message, from LangGraph's stream
 *  metadata (the same for every chunk of one model call). */
export function streamedModel(metadata: unknown): string | undefined {
  const { ls_provider: provider, ls_model_name: model } = (metadata ??
    {}) as Record<string, unknown>;
  return typeof provider === "string" && typeof model === "string"
    ? `${provider}:${model}`
    : undefined;
}

/** One per chat: `runStarting()` right before each run it submits, and
 *  `observe()` with the live stream's messages on every update. `modelOf`
 *  names the model that streamed a message, when known. */
export function createThinkingClock(
  modelOf: (message: Message) => string | undefined = () => undefined
) {
  // The parts of a split reply come from one model call; an old core keeps a
  // failed call's first chunk, and a fallback model answers after it.
  const sameModel = (a: Message, b: Message) => {
    const model = modelOf(a);
    return model !== undefined && model === modelOf(b);
  };
  let submitted = false;
  // The run in flight was started here.
  let timed = false;
  let wasLoading = false;
  // The reply being timed, by every id it streams under; the last is followed.
  let current: { ids: string[]; start: number } | null = null;
  const seen = new Set<string>();
  return {
    runStarting() {
      submitted = true;
    },
    observe(messages: Message[], isLoading: boolean, now = performance.now()) {
      if (isLoading && !wasLoading) {
        timed = submitted;
        submitted = false;
      }
      wasLoading = isLoading;
      const last = messages.at(-1);
      if (current) {
        const { ids, start } = current;
        // The latest of its messages still there: when the step ends, the
        // saved reply replaces the rest under the response's id.
        let message: Message | undefined;
        for (const id of ids) {
          message = messages.find((m) => m.id === id) ?? message;
        }
        if (
          isResponseHead(message) &&
          messages.at(-2) === message &&
          last?.type === "ai" &&
          last.id &&
          !seen.has(last.id) &&
          !isResponseHead(last) &&
          sameModel(message, last)
        ) {
          // The rest of the reply, right after its first chunk.
          seen.add(last.id);
          ids.push(last.id);
          message = last;
        }
        if (message && replyStarted(message)) {
          const took = Math.max(0, Math.floor((now - start) / 1000));
          for (const id of ids) record(id, took);
        } else if (message && message === last && isLoading) {
          return;
        } else if (!message && last?.type === "ai" && last.id) {
          // Gone: cut before a retry, or its id changed. A reply in its
          // place now may be the same one, so it has no time either.
          seen.add(last.id);
        }
        // Answered, or stopped, failed, cut or followed by another message
        // before it answered.
        current = null;
      }
      if (!isLoading || !timed || last?.type !== "ai" || !last.id) return;
      if (seen.has(last.id)) return;
      seen.add(last.id);
      if (replyStarted(last)) return;
      const ids = [last.id];
      // The reply's empty first part came in the same update.
      const before = messages.at(-2);
      if (
        isResponseHead(before) &&
        !isResponseHead(last) &&
        !seen.has(before.id) &&
        sameModel(before, last)
      ) {
        seen.add(before.id);
        ids.unshift(before.id);
      }
      current = { ids, start: now };
    },
  };
}

/** "Thought for 12s", "Thought for 1m 5s", or "Thought" without a time. */
export function thoughtLabel(took: number | null): string {
  if (!took) return "Thought";
  if (took < 60) return `Thought for ${took}s`;
  const rest = took % 60;
  return `Thought for ${Math.floor(took / 60)}m${rest ? ` ${rest}s` : ""}`;
}
