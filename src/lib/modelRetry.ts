// Model-call retries (EvoScientist/middleware/model_retry.py).
//
// The backend retries a transient model failure itself and narrates it on the
// `custom` stream channel with untagged events (not `{evoscientist: …}`):
//   {type: "model_call", phase: "start" | "end", call, status?}  around every provider call
//   {type: "model_retry", attempt, wait_seconds, reason, agent, …} before each wait
// A call that fails after streaming leaves its half answer in the live view
// (it never reaches thread state), and the retry streams a new message below
// it. The CLI drops a failed call's output by these marks; `useChat` does the
// same for the main agent with the helpers below, and shows the retry as a
// toast.

const MAX_NOTICE_LENGTH = 240;

export type ModelCallStatus = "clean" | "error" | "failed";

export type ModelCallEvent =
  | { phase: "start"; call: string }
  | { phase: "end"; call: string; status: ModelCallStatus };

export interface ModelRetryEvent {
  /** The attempt about to run (2 for the first retry); 1 if unknown, as in the CLI. */
  attempt: number;
  waitSeconds: number;
  reason: string;
  /** The agent whose call failed (`lc_agent_name`); "" if unknown. */
  agent: string;
}

function asRecord(data: unknown): Record<string, unknown> | null {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export function parseModelCallEvent(data: unknown): ModelCallEvent | null {
  const payload = asRecord(data);
  if (payload?.type !== "model_call") return null;
  const { phase, call, status } = payload;
  if (typeof call !== "string" || !call) return null;
  if (phase === "start") return { phase, call };
  if (phase !== "end") return null;
  // Same rule as the CLI decoder: anything but clean/error counts as failed.
  return {
    phase,
    call,
    status: status === "clean" || status === "error" ? status : "failed",
  };
}

export function parseModelRetryEvent(data: unknown): ModelRetryEvent | null {
  const payload = asRecord(data);
  if (payload?.type !== "model_retry") return null;
  const { attempt, wait_seconds, reason, agent } = payload;
  return {
    // The CLI decoder's `_count(attempt) or 1`.
    attempt:
      typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0
        ? attempt
        : 1,
    waitSeconds:
      typeof wait_seconds === "number" &&
      Number.isFinite(wait_seconds) &&
      wait_seconds > 0
        ? wait_seconds
        : 0,
    reason: typeof reason === "string" ? reason.trim() : "",
    agent: typeof agent === "string" ? agent.trim() : "",
  };
}

// Python's `f"{x:.0f}"`: an exact half goes to the even neighbour (2.5 -> 2).
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const rest = x - floor;
  if (rest !== 0.5) return Math.round(x);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The CLI's retry line (`stream/display.py:model_retry_text`), capped for a toast. */
export function modelRetryText(
  event: ModelRetryEvent,
  { subagent }: { subagent: boolean }
): string {
  const wait =
    event.waitSeconds >= 1
      ? String(roundHalfEven(event.waitSeconds))
      : event.waitSeconds.toFixed(1);
  // A sub-agent's retry is named; the main agent's is not.
  const who = subagent && event.agent ? `${event.agent}: ` : "";
  const tail = `); retrying in ${wait} s (attempt ${event.attempt})`;
  const head = `${who}Model request failed (`;
  // Provider errors can run to pages; shorten the reason, keep the retry info.
  const room = MAX_NOTICE_LENGTH - head.length - tail.length;
  let reason = event.reason || "transient error";
  if (reason.length > room) reason = `${reason.slice(0, room - 1)}…`;
  return `${head}${reason}${tail}`;
}

/** One provider call of the main agent, from its start mark to its end mark. */
export interface ModelCallRecord {
  call: string;
  state: "open" | ModelCallStatus;
  /** Ids of the AI messages already on screen when the call started. */
  baseline: ReadonlySet<string>;
}

function aiMessageIds(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const m = asRecord(message);
    if (m?.type === "ai" && typeof m.id === "string") ids.add(m.id);
  }
  return ids;
}

export function openModelCall(
  call: string,
  messages: readonly unknown[]
): ModelCallRecord {
  return { call, state: "open", baseline: aiMessageIds(messages) };
}

/** A new call drops its predecessor's output only when that call ended badly. */
export function callEndedBadly(record: ModelCallRecord): boolean {
  return record.state === "error" || record.state === "failed";
}

/** A retry drops the output of any call that did not end clean, even one whose end mark was lost. */
export function callIsDiscardable(record: ModelCallRecord): boolean {
  return record.state !== "clean";
}

/** The AI messages that appeared after the call started: its own output. */
export function failedCallOutputIds(
  record: ModelCallRecord,
  messages: readonly unknown[]
): Set<string> {
  const ids = aiMessageIds(messages);
  for (const id of record.baseline) ids.delete(id);
  return ids;
}

/**
 * `messages` without the given ones, but only when they are its tail;
 * otherwise `messages` itself, unchanged.
 *
 * The SDK writes each streamed chunk at the list index its message got on its
 * first chunk (`MessageTupleManager.get(id, defaultIndex)`), so removing a
 * message that has others after it would make a later chunk of one of those
 * land on the wrong slot (a duplicate). The backend runs one call at a time,
 * so a failed call's output is always the tail; anything else is left to the
 * model step's `values` event, which replaces the list. A removed message
 * gets no later chunk: the stream is ordered, and a call's failure is
 * announced only after its last chunk.
 */
export function withoutTrailingMessages<T>(
  messages: T[],
  ids: ReadonlySet<string>
): T[] {
  if (ids.size === 0) return messages;
  const isDropped = (m: T) => {
    const id = asRecord(m)?.id;
    return typeof id === "string" && ids.has(id);
  };
  const first = messages.findIndex(isDropped);
  if (first < 0) return messages;
  if (!messages.slice(first).every(isDropped)) return messages;
  return messages.slice(0, first);
}

/** Where the retry notice goes; `useChat` shows it as a toast. */
export interface RetryNoticeSink {
  show(text: string, waitSeconds: number): void;
  dismiss(): void;
}

/** The two sonner calls the retry toast needs. */
export interface RetryToastApi {
  warning(
    text: string,
    options: {
      id: string;
      duration: number;
      closeButton: boolean;
      onAutoClose: () => void;
      onDismiss: () => void;
    }
  ): unknown;
  dismiss(id: string): unknown;
}

// Shared by every chat instance, so a remounted chat never reuses an id.
let retryToastSerial = 0;

/**
 * The retry notice as sonner toasts: one toast per retry, the previous one
 * closed. Updating a toast in place is not enough: sonner keeps the old
 * remaining time of a toast whose timer was paused (hover, hidden tab) unless
 * its duration changes, and it merges a toast created with the id of one it is
 * still animating out into that one, so a reused id can show nothing.
 */
export function createRetryToasts(api: RetryToastApi): RetryNoticeSink {
  let current: string | null = null;
  const release = (id: string) => () => {
    if (current === id) current = null;
  };
  return {
    show(text, waitSeconds) {
      if (current !== null) {
        // Sonner adds a toast on a 0 ms timer but delivers a dismiss after two
        // animation frames, and drops a dismiss for a toast it has not added
        // yet. Two retries in one frame (parallel sub-agents) on a busy page
        // could therefore leave the first toast up; queueing the dismiss
        // behind sonner's add keeps the order.
        const previous = current;
        setTimeout(() => api.dismiss(previous), 0);
      }
      retryToastSerial += 1;
      const id = `model-retry-${retryToastSerial}`;
      current = id;
      api.warning(text, {
        id,
        // Up through the wait plus a normal toast's 4 s, unless the retried
        // call ends clean or the run ends first. It is stale once the retry
        // starts and can cover the inspector's tabs, so it must not outlive
        // the wait by much, and a long wait (a provider's Retry-After) can be
        // closed.
        duration: Math.round(waitSeconds * 1000) + 4000,
        closeButton: true,
        onAutoClose: release(id),
        onDismiss: release(id),
      });
    },
    dismiss() {
      if (current === null) return;
      api.dismiss(current);
      current = null;
    },
  };
}

/** The SDK's `mutate` from `onCustomEvent`: reads and patches the live stream values. */
type StreamMutate = (
  update: (prev: { messages?: unknown[] }) => { messages?: unknown[] }
) => void;

/**
 * Follows the model-call marks and retries of one stream, mirroring the CLI
 * decoder (`EvoScientist/stream/events.py`, `_process_model_call` /
 * `_process_model_retry`) for the main agent:
 * - a new call drops its predecessor's output when that call ended badly
 *   (a fallback model taking over); a call whose end mark never came keeps it;
 * - a retry drops the output of any call that did not end clean.
 * A sub-agent's output is not dropped (its steps are a separate projection);
 * its retries are only announced.
 *
 * Every retry shows the notice; it is dismissed when the call made after the
 * retry, in the same namespace, ends clean, or by `reset()` when the run ends.
 * State lives for one run: call `reset()` when it ends or a new one starts.
 */
export class ModelRetryTracker {
  private call: ModelCallRecord | null = null;
  // The namespace whose retry the notice shows, and the call started after it.
  private notice: { namespace: string; call: string | null } | null = null;
  private readonly notices: RetryNoticeSink;

  constructor(notices: RetryNoticeSink) {
    this.notices = notices;
  }

  /** Handles one `custom` event; true when it was a model-call mark or a retry. */
  handle(
    data: unknown,
    options?: { namespace?: string[]; mutate?: unknown }
  ): boolean {
    const namespace = (options?.namespace ?? []).join("|");
    const mutate =
      typeof options?.mutate === "function"
        ? (options.mutate as StreamMutate)
        : undefined;
    const callEvent = parseModelCallEvent(data);
    if (callEvent) {
      this.followNotice(namespace, callEvent);
      if (namespace === "") this.trackMainCall(callEvent, mutate);
      return true;
    }
    const retry = parseModelRetryEvent(data);
    if (retry) {
      this.notice = { namespace, call: null };
      this.notices.show(
        modelRetryText(retry, { subagent: namespace !== "" }),
        retry.waitSeconds
      );
      if (namespace === "") this.dropFailedMainCall(mutate);
      return true;
    }
    return false;
  }

  /** Forgets the run's calls and closes a notice that is still up. */
  reset(): void {
    this.call = null;
    if (this.notice === null) return;
    this.notice = null;
    this.notices.dismiss();
  }

  private followNotice(namespace: string, event: ModelCallEvent): void {
    const notice = this.notice;
    if (notice === null || notice.namespace !== namespace) return;
    if (event.phase === "start") {
      notice.call ??= event.call;
      return;
    }
    if (event.call !== notice.call) return;
    if (event.status === "clean") {
      this.notice = null;
      this.notices.dismiss();
    } else {
      // That model failed too; a fallback model may still answer.
      notice.call = null;
    }
  }

  private trackMainCall(
    event: ModelCallEvent,
    mutate: StreamMutate | undefined
  ) {
    if (event.phase === "end") {
      const record = this.call;
      // Like the CLI: only the open call's own end mark closes it.
      if (record?.call === event.call && record.state === "open") {
        this.call = { ...record, state: event.status };
      }
      return;
    }
    const previous = this.call;
    this.call = null;
    if (!mutate) return;
    mutate((prev) => {
      const messages = prev.messages ?? [];
      const kept =
        previous && callEndedBadly(previous)
          ? withoutTrailingMessages(
              messages,
              failedCallOutputIds(previous, messages)
            )
          : messages;
      this.call = openModelCall(event.call, kept);
      return kept === messages ? {} : { messages: kept };
    });
  }

  private dropFailedMainCall(mutate: StreamMutate | undefined) {
    const record = this.call;
    if (!record || !callIsDiscardable(record)) return;
    this.call = null;
    if (!mutate) return;
    mutate((prev) => {
      const messages = prev.messages ?? [];
      const kept = withoutTrailingMessages(
        messages,
        failedCallOutputIds(record, messages)
      );
      return kept === messages ? {} : { messages: kept };
    });
  }
}
