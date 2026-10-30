"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useStream,
  type UseStreamOptions,
  type UseStreamThread,
} from "@langchain/langgraph-sdk/react";
import { type Message } from "@langchain/langgraph-sdk";
import { v4 as uuidv4 } from "uuid";
import type { TodoItem } from "@/app/types/types";
import { useClient } from "@/providers/ClientProvider";
import { useQueryState } from "nuqs";
import { pickThreadMessages } from "@/lib/threadMessages";
import { pinnedSkillName } from "@/lib/pinnedSkill";
import { isRubricRevision } from "@/lib/rubricRevision";
import { withoutNestedRuns } from "@/lib/nestedRuns";
import type { GoalRequest } from "@/lib/goalCommand";
import {
  goalEventKey,
  goalEventNotice,
  parseGoalEvent,
  type GoalEvent,
} from "@/lib/goalEvents";
import {
  lastRubricVerdict,
  threadGoal,
  type RubricVerdict,
  type ThreadGoal,
} from "@/lib/goalState";
import { useGoalSupport } from "@/app/hooks/useGoalSupport";
import { parseSummarizationEvent } from "@/lib/summarization";
import {
  applySubagentEvent,
  finalizeRunning,
  mergeWorkflowMaps,
  parseSubagentEvent,
  type WorkflowMap,
} from "@/lib/dynamicWorkflow";
import { loadThreadWorkflows, saveThreadWorkflows } from "@/lib/workflowStore";
import { subAgentStreamsToSteps } from "@/lib/subAgentActivity";
import { toast } from "sonner";
import { parseFallbackNotice } from "@/lib/middlewareEvents";
import { createRetryToasts, ModelRetryTracker } from "@/lib/modelRetry";
import { createThinkingClock, streamedModel } from "@/lib/thinkingTimer";
import {
  MODEL_OVERRIDE_METADATA_KEY,
  type ModelOverride,
} from "@/lib/modelCommand";
import {
  deriveThreadMetadata,
  persistThreadDerivedMetadata,
  setThreadModelOverride,
  stampThreadWorkspace,
} from "@/app/hooks/useThreads";
import { useProjects } from "@/providers/ProjectsProvider";
import { findProject } from "@/lib/projects";
import { retryWithBackoff } from "@/lib/retry";
import {
  assistantIsMissing,
  formatStreamError,
  getHttpStatus,
  folderRefusal,
  isMissingThreadOrAssistantError,
  missingThreadIdFromError,
} from "@/lib/streamError";
import { CHAT_GRAPH_ID, workspaceAssistantId } from "@/lib/workspaceAssistant";
import {
  CHAT_GRAPHS,
  canRun,
  threadBinding,
  threadFolders,
  runFolderIn,
  type ThreadFolders,
} from "@/lib/threadBinding";
import { extractStringFromMessageContent } from "@/app/utils/utils";

export type StateType = {
  messages: Message[];
  // A /goal request (core middleware/goal.py). Only in run inputs: every
  // message writes null so a leftover request is not drafted again.
  goal_request?: GoalRequest | null;
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
  // Private state field set by the deepagents SummarizationMiddleware when the
  // conversation is compacted. langgraph dev exposes it over the SDK; the UI
  // surfaces it as a collapsible "Conversation compacted" block.
  _summarization_event?: unknown;
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
 * A stable key for an interrupt, used to tell "the stale interrupt the server
 * already resolved" apart from "a genuinely new interrupt". Prefer the
 * backend-supplied `Interrupt.id` (unique per logical interrupt, populated
 * consistently by LangGraph's checkpoint state on both the live
 * `values.__interrupt__` path and the getState-fetched path). Falling back to
 * a `value` content hash would collapse two calls to the same tool with the
 * same args - the "repeat the same action" scenario - making auto-approve
 * skip legitimate re-approvals. Object identity alone can't be trusted
 * because the SDK's getter re-derives the object per render.
 */
function coerceInterrupt(i: unknown): unknown {
  return Array.isArray(i) ? i[i.length - 1] : i;
}

export function interruptValueKey(i: unknown): string | null {
  if (!i || typeof i !== "object") return null;
  const asObj = i as { id?: unknown; value?: unknown };
  if (typeof asObj.id === "string" && asObj.id.length > 0) {
    return `id:${asObj.id}`;
  }
  try {
    return `v:${JSON.stringify(asObj.value ?? null)}`;
  } catch {
    return null;
  }
}

// Thread statuses under which no run can still be producing tool results.
// "busy" is a run in flight; anything unlisted is a state we do not know.
const SETTLED_THREAD_STATUSES = new Set(["idle", "interrupted", "error"]);

function lastHumanMessageId(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message | null;
    // The pinned-skill message and the grader's request for revisions are
    // not user turns; counting one would read the stopped turn's own
    // late-arriving message as a new turn.
    if (
      m?.type === "human" &&
      pinnedSkillName(m) === null &&
      !isRubricRevision(m)
    ) {
      return typeof m.id === "string" ? m.id : null;
    }
  }
  return null;
}

function hasActionableInterrupt(i: unknown): boolean {
  if (!i || typeof i !== "object") return false;
  const value = (i as { value?: unknown }).value;
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; action_requests?: unknown };
  return (
    v.type === "ask_user" ||
    (Array.isArray(v.action_requests) && v.action_requests.length > 0)
  );
}

export function latestTaskInterrupt(
  tasks:
    | Array<{ interrupts?: unknown[]; result?: unknown; error?: unknown }>
    | undefined
): unknown {
  if (!Array.isArray(tasks)) return undefined;
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (!task || task.result != null || task.error != null) continue;
    const interrupts = task.interrupts;
    if (Array.isArray(interrupts) && interrupts.length > 0) {
      return interrupts[interrupts.length - 1];
    }
  }
  return undefined;
}

/** What a run refused for its project's sake says. `back`: the message is
 *  back in the composer; `newChat`: in a new chat. */
function projectGoneMessage(back: boolean, newChat: boolean): string {
  const gone =
    "This project is no longer served: it was removed from the backend, or its folder is missing.";
  if (!back) return gone;
  return newChat
    ? `${gone} Started a new chat; your message is back in the composer.`
    : `${gone} Your message is back in the composer.`;
}

/** Payload handed to `onThreadUnavailable` when the open thread is gone. */
export interface ThreadUnavailableInfo {
  /** The thread the URL pointed at when the backend reported it missing. */
  threadId: string;
  /**
   * Text of the message whose submit triggered the 404 (the thread vanished
   * between page load and send), or null when the 404 came from the initial
   * history fetch and nothing was pending.
   */
  unsentMessage: string | null;
}

/** A run's grading mode (the core's `configurable.rubric_run.mode`): the
 *  user's turns and /goal requests are "thread"; a report the WebUI sends
 *  for finished background work is "followup", which only completes a
 *  grading that was waiting for it. */
export type RunMode = "thread" | "followup";
/** A goal run's step the goal pill shows while it lasts. */
export type GoalBusy = "drafting" | "checking" | null;

function goalBusyAfter(event: GoalEvent): GoalBusy {
  if (event.type === "goal_state") {
    return event.change === "drafting" ? "drafting" : null;
  }
  return event.type === "rubric_evaluation_start" ? "checking" : null;
}

export function useChat({
  onHistoryRevalidate,
  onThreadUnavailable,
  thread,
}: {
  onHistoryRevalidate?: () => void;
  /**
   * Called instead of the local `setThreadId(null)` fallback when the
   * backend says the open thread/assistant no longer exists. The page uses it
   * to route through its regular New-Chat reset (auto-approve sentinel,
   * view, ChatProvider remount) and to re-seed the composer with any unsent
   * message. Return `false` to reject the report (it was about a thread the
   * user has already left) — nothing is reset or toasted then.
   */
  /** False: the report was ignored. `unsentBack`: whether the unsent
   *  message reached the new chat's composer. */
  onThreadUnavailable?: (
    info: ThreadUnavailableInfo
  ) => boolean | void | { unsentBack: boolean };
  thread?: UseStreamThread<StateType>;
}) {
  const [threadId, setThreadId] = useQueryState("threadId");
  // The SDK runs a run's callbacks from the render that submitted it, which
  // for a new chat's first run knew no thread yet.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const client = useClient();
  // useStream reads through this one: a middleware's nested run (goal
  // drafter, rubric grader) would otherwise take over the chat's values.
  const streamClient = useMemo(() => withoutNestedRuns(client), [client]);
  const {
    projects,
    refreshing,
    isReady,
    refresh: refreshProjects,
    current,
    selectProject,
  } = useProjects();
  const goalSupported = useGoalSupport();
  // The mode of the run a resume continues; null after a reload, which
  // resumes as "thread" (a goal review only pauses a thread run).
  const lastRunModeRef = useRef<RunMode | null>(null);
  // Goal events shown in this run: a replay on reconnect shows nothing twice.
  const goalEventKeysRef = useRef(new Set<string>());
  // Every goal read takes a number; only the latest one is kept.
  const goalReadRef = useRef(0);
  const [goalState, setGoalState] = useState<{
    threadId: string;
    goal: ThreadGoal | null;
    verdict: RubricVerdict | null;
  } | null>(null);
  const [goalBusy, setGoalBusy] = useState<GoalBusy>(null);
  const applyGoalRead = useCallback(
    (read: number, id: string, values: unknown) => {
      if (read !== goalReadRef.current) return;
      setGoalState({
        threadId: id,
        goal: threadGoal(values),
        verdict: lastRubricVerdict(values),
      });
    },
    []
  );
  // The goal lives in thread state (getState), not in the streamed values.
  const refreshGoal = useCallback(
    (id: string | null) => {
      if (!id) return;
      const read = ++goalReadRef.current;
      client.threads
        .getState(id)
        .then((state) =>
          applyGoalRead(read, id, (state as { values?: unknown }).values)
        )
        .catch(() => {
          // The next read (the run's end, a thread load) tries again.
        });
    },
    [client, applyGoalRead]
  );
  // The open thread's own metadata: its graph and the folders it records.
  // It holds for the backend it was read from (`openMeta`).
  const [threadMeta, setThreadMeta] = useState<{
    threadId: string;
    client: typeof client;
    metadata: Record<string, unknown>;
  } | null>(null);
  const openMeta =
    threadMeta &&
    threadMeta.threadId === threadId &&
    threadMeta.client === client
      ? threadMeta
      : null;
  useEffect(() => {
    if (!threadId) return;
    // Until it is read the thread stays pending, so a failed read is retried
    // rather than guessed. A missing thread (404) is final: the stream's 404
    // handling takes it from there.
    const controller = new AbortController();
    let gone = false;
    void retryWithBackoff(
      () => client.threads.get(threadId),
      controller.signal,
      10_000,
      (error) => {
        gone = getHttpStatus(error) === 404;
        return gone ? false : undefined;
      }
    ).then((t) => {
      if (controller.signal.aborted || (!t && !gone)) return;
      setThreadMeta({
        threadId,
        client,
        metadata: (t?.metadata ?? {}) as Record<string, unknown>,
      });
    });
    return () => controller.abort();
  }, [client, threadId]);
  // Id of the human message the most recent `sendMessage` submitted. If the
  // submit fails with a thread-gone 404, this is the message that never made
  // it and should be handed back to the user.
  const lastSubmittedHumanIdRef = useRef<string | null>(null);
  // A goal request sends no message: the /goal text it came from, until
  // the backend has made its run.
  const unsentGoalRef = useRef<string | null>(null);

  const [dynamicWorkflows, setDynamicWorkflows] = useState<WorkflowMap>({});
  const workflowThreadIdRef = useRef(threadId);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Model-call retries (lib/modelRetry.ts): announces each retry and drops the
  // main agent's failed-call output from the live view. Its state lasts one
  // run; the reset sites are the run ending (`isLoading` falling, below), Stop,
  // a new submit and unmount.
  const [retryTracker] = useState(
    () => new ModelRetryTracker(createRetryToasts(toast))
  );
  useEffect(() => () => retryTracker.reset(), [retryTracker]);

  // The chat runs on the chat graph's assistant for the thread's project; a
  // thread of another chat graph (a scheduled task's thread) runs on that
  // graph's assistant for the same project. The graph and the project come
  // from the thread's own metadata: the stream needs the assistant before it
  // loads the history that carries the checkpoint's copy, and the SDK, the
  // server and this WebUI set them on the thread. A new chat runs in the
  // current project.
  const openGraph = openMeta?.metadata["graph_id"] as string | undefined;
  const threadGraph =
    openGraph && CHAT_GRAPHS.has(openGraph) ? openGraph : CHAT_GRAPH_ID;
  // The project the latest run here was sent in. A new chat's first run
  // creates its thread, whose metadata is read only after: until then the
  // run's own project keeps the assistant, so it doesn't change mid-stream.
  const [sentIn, setSentIn] = useState<{
    threadId: string | null;
    key: string;
    /** The run made the thread (a new chat's first run). */
    created?: boolean;
  } | null>(null);
  const sentInRef = useRef(sentIn);
  sentInRef.current = sentIn;
  const metaBinding = threadBinding(
    projects,
    !threadId
      ? null
      : openMeta
      ? threadFolders(openMeta.metadata, undefined)
      : undefined,
    CHAT_GRAPHS,
    current?.key ?? null
  );
  const assistantKey =
    metaBinding.kind === "open" || metaBinding.kind === "unbound"
      ? metaBinding.key
      : sentIn && sentIn.threadId === threadId
      ? sentIn.key
      : null;
  // Computed from the project list this render carries, so it can never
  // belong to another project than the one the gate was opened for.
  const threadAssistantId = assistantKey
    ? workspaceAssistantId(threadGraph, assistantKey)
    : "";
  // Goals only on the chat graph: the scheduler graph has no goal
  // middleware, so a goal request on a scheduled task's thread would be
  // dropped and the agent would answer its last turn again. Unknown while an
  // open thread's own metadata is out, since until then a scheduled task's
  // thread reads as the chat graph's. The run marker still follows
  // goalSupported: a graph without the middleware ignores it.
  const goalsHere =
    threadId !== null && !openMeta
      ? undefined
      : threadGraph === CHAT_GRAPH_ID
      ? goalSupported
      : false;

  // A message the backend refused before running it goes back to the
  // composer, which registers how (`setRefusalHandler`).
  // The handler answers false when the text did not come back (a /goal
  // command that would be glued onto other text there).
  const refusalHandlerRef = useRef<((text: string) => boolean | void) | null>(
    null
  );
  const setRefusalHandler = useCallback(
    (handler: ((text: string) => boolean | void) | null) => {
      refusalHandlerRef.current = handler;
    },
    []
  );
  // The message the latest send submitted, if the stream still ends on it:
  // the one a gone thread leaves unsent.
  const takeUnsentMessage = (): string | null => {
    const last = streamRef.current.messages.at(-1);
    const unsentMessage =
      last &&
      last.type === "human" &&
      last.id != null &&
      last.id === lastSubmittedHumanIdRef.current
        ? extractStringFromMessageContent(last).trim() || null
        : null;
    const goalText = unsentGoalRef.current;
    lastSubmittedHumanIdRef.current = null;
    unsentGoalRef.current = null;
    return unsentMessage ?? goalText;
  };

  // The thread a refused first message made holds nothing and is bound to a
  // project the backend no longer serves: delete it, so it doesn't come back
  // empty if that folder is added again. Best effort.
  const dropRefusedThread = (id: string) => {
    void client.threads.delete(id).catch(() => {});
  };

  // Whether `id` is the thread a new chat's first run made here.
  const isNewChatThread = (id: string | null): boolean => {
    const sent = sentInRef.current;
    return (
      id !== null &&
      sent !== null &&
      sent.created === true &&
      sent.threadId === id
    );
  };

  // A run refused because its project is no longer served (removed, or its
  // folder missing). The projects are read again, which moves the current
  // project on. The message goes back to the composer; nothing is sent again
  // by itself, so a run never starts in a project the user didn't choose. A
  // new chat's first message made a thread bound to the gone project: start
  // over in a new chat, with the message.
  const handProjectGone = () => {
    const refusedOn = runStateRef.current.threadId;
    const newThread = isNewChatThread(refusedOn);
    const unsent = takeUnsentMessage();
    void refreshProjects();
    if (newThread && refusedOn && onThreadUnavailable) {
      dropRefusedThread(refusedOn);
      const handled = onThreadUnavailable({
        threadId: refusedOn,
        unsentMessage: unsent,
      });
      if (handled === false) return;
      const back = typeof handled === "object" && handled.unsentBack;
      toast.error(projectGoneMessage(back, true));
      return;
    }
    const handBack = refusalHandlerRef.current;
    const inComposer =
      unsent !== null && handBack !== null && handBack(unsent) !== false;
    toast.error(projectGoneMessage(inComposer, false));
  };

  // The open thread is gone: hand back an unsent message and start over.
  // `inComposer`: it is back in the composer already, and goes along with
  // the draft.
  const reportThreadUnavailable = (
    threadId: string,
    unsentMessage = takeUnsentMessage(),
    inComposer = false
  ) => {
    let unsentBack = unsentMessage !== null;
    if (onThreadUnavailable) {
      const handled = onThreadUnavailable({ threadId, unsentMessage });
      if (handled === false) return;
      if (typeof handled === "object") unsentBack = handled.unsentBack;
    } else {
      void setThreadId(null);
    }
    toast.error(
      unsentBack || inComposer
        ? onThreadUnavailable || inComposer
          ? "This conversation is no longer available. Started a new chat; your unsent message is back in the composer."
          : "This conversation is no longer available. Started a new chat; your last message was not sent."
        : "This conversation is no longer available. Started a new chat."
    );
  };

  const streamOptions: UseStreamOptions<StateType> & {
    filterSubagentMessages: boolean;
  } = {
    // The open thread's assistant. Every submitter checks `canSend` first,
    // so the empty id is never sent.
    assistantId: threadAssistantId,
    client: streamClient,
    reconnectOnMount: true,
    threadId: threadId ?? null,
    onThreadId: (id) => {
      // The thread a new chat's first run made: the run's project is that
      // thread's until its metadata is read.
      const sent = sentInRef.current;
      if (sent && sent.threadId === null) {
        const pinned = { threadId: id, key: sent.key, created: true };
        sentInRef.current = pinned;
        setSentIn(pinned);
      }
      void setThreadId(id);
    },
    defaultHeaders: { "x-auth-scheme": "langsmith" },
    // NOTE: do NOT set `throttle: <ms>` here. The SDK's `throttle` option
    // (from 1.1.0) is implemented as a debounce in `dist/ui/manager.js` -
    // each notification cancels the previous timer and restarts it. Under
    // continuous streaming (backend emits frames faster than the timer
    // window), the timer never fires and updates accumulate silently until
    // the model briefly pauses, at which point the entire buffer flushes in
    // one avalanche render (visible as "chat freezes for minutes, then
    // suddenly unfolds"). The always-on setTimeout(0) RootMessageProjection
    // coalescing added in SDK 1.9.3 does the actual render-pressure fix we
    // wanted from throttle - flushes every macrotask, not every debounce
    // window - so we don't need the option here.
    // Enable fetching state history when switching to existing threads
    fetchStateHistory: true,
    // Keep synchronous DeepAgent messages out of the root transcript and let
    // the SDK bind them to their exact parent `task` tool-call id. The same
    // option enables SDK checkpoint hydration after refresh/thread switches.
    filterSubagentMessages: true,
    // Revalidate thread list when stream finishes, errors, or creates new
    // thread. Errors additionally surface a toast with the SDK's payload -
    // without this the user only sees React's generic "An internal error
    // occurred" and has to dig into the server log to learn that, e.g., a
    // model provider returned a quota error.
    onFinish: () => {
      lastSubmittedHumanIdRef.current = null;
      unsentGoalRef.current = null;
      onHistoryRevalidate?.();
    },
    onError: (error) => {
      // A history fetch or run can reject after this hook instance was torn
      // down (the page remounts ChatProvider on thread switches and on New
      // Chat); the user has moved on, so nothing here applies any more.
      if (!mountedRef.current) return;
      onHistoryRevalidate?.();
      if (isMissingThreadOrAssistantError(error) && !threadId) {
        // With no thread in the URL, a "Thread with ID … not found" can only
        // be a late history-fetch rejection for a thread we already left
        // (dev StrictMode double-fetches, slow backends) — drop it. A run-path
        // "Thread or assistant not found." on a brand-new chat is a genuine
        // assistant misconfiguration and still surfaces below.
        if (/thread with id/i.test(formatStreamError(error))) return;
      }
      const refusal = folderRefusal(error);
      if (refusal === "mismatch") {
        // The thread is bound to another project or run folder than its
        // metadata says: read the projects again (runs wait until they are
        // in) and say why it refused.
        lastSubmittedHumanIdRef.current = null;
        unsentGoalRef.current = null;
        void refreshProjects();
        toast.error(formatStreamError(error));
        return;
      }
      if (refusal === "projectGone") {
        handProjectGone();
        return;
      }
      // The run path answers a missing assistant and a missing thread with
      // the same 404. A new chat's thread was just created, and an open
      // thread that still exists means the assistant is what's missing:
      // resolve it again and keep the conversation.
      if (
        isMissingThreadOrAssistantError(error) &&
        /thread or assistant not found/i.test(formatStreamError(error))
      ) {
        // At once, before the check: the folder read closes the gate, so
        // nothing else runs into the same 404 meanwhile, and the message goes
        // back to the composer, ahead of what was queued after it. The
        // refusal belongs to the thread open now (a new chat's thread was
        // just made).
        const refusedOn = runStateRef.current.threadId;
        const newThread = isNewChatThread(refusedOn);
        const unsent = takeUnsentMessage();
        void refreshProjects();
        const handBack = refusalHandlerRef.current;
        const inComposer =
          unsent !== null && handBack !== null && handBack(unsent) !== false;
        // Only a 404 means the thread is gone; any other failure to check
        // keeps the conversation. One toast, for what the check found.
        void assistantIsMissing(client, refusedOn).then((missing) => {
          // Another thread is open since (a new chat getting its id is not
          // one): it replaced this composer, so there is nothing to say.
          const openNow = runStateRef.current.threadId;
          if (
            !mountedRef.current ||
            (refusedOn !== null && openNow !== refusedOn)
          ) {
            return;
          }
          if (!missing) {
            // Handed to the composer, the text is dealt with there.
            reportThreadUnavailable(
              refusedOn as string,
              handBack !== null ? null : unsent,
              inComposer
            );
            return;
          }
          // The core makes every registered project's assistants, so a
          // missing one means the project is gone. A new chat's thread is
          // bound to it: start over in a new chat, which takes the composer
          // along.
          if (newThread && refusedOn && onThreadUnavailable) {
            dropRefusedThread(refusedOn);
            const handled = onThreadUnavailable({
              threadId: refusedOn,
              // In the composer already, it goes along with the draft.
              unsentMessage: inComposer ? null : unsent,
            });
            if (handled === false) return;
            const back =
              inComposer || (typeof handled === "object" && handled.unsentBack);
            toast.error(projectGoneMessage(back, true));
            return;
          }
          toast.error(projectGoneMessage(inComposer, false));
        });
        return;
      }
      if (threadId && isMissingThreadOrAssistantError(error)) {
        const reported = missingThreadIdFromError(error);
        if (reported && reported !== threadId) return;
        reportThreadUnavailable(threadId);
        return;
      }
      lastSubmittedHumanIdRef.current = null;
      unsentGoalRef.current = null;
      toast.error(formatStreamError(error));
    },
    // The backend made the run, so a goal request was not refused.
    onCreated: () => {
      unsentGoalRef.current = null;
      onHistoryRevalidate?.();
    },
    onCustomEvent: (data, options) => {
      // A fallback chain emits several notices (failed → falling back →
      // succeeded); one toast id lets each replace the last instead of
      // stacking. Sub-agent fallbacks matter too, so this runs before the
      // root-namespace gate below.
      const notice = parseFallbackNotice(data);
      if (notice) {
        toast[notice.level](notice.text, { id: "model-fallback" });
        return;
      }
      if (retryTracker.handle(data, options)) return;
      // Before the root-namespace gate: "drafting" comes from the drafter's
      // nested namespace.
      const goalEvent = parseGoalEvent(data);
      if (goalEvent) {
        // The SDK doesn't stop a run when its chat unmounts (a thread
        // switch): such a run's events belong to a thread no longer shown.
        if (!mountedRef.current) return;
        const key = goalEventKey(goalEvent);
        if (goalEventKeysRef.current.has(key)) return;
        goalEventKeysRef.current.add(key);
        const notice = goalEventNotice(goalEvent);
        if (notice) toast[notice.level](notice.text);
        setGoalBusy(goalBusyAfter(goalEvent));
        if (
          goalEvent.type === "goal_state" &&
          goalEvent.change !== "drafting"
        ) {
          refreshGoal(threadIdRef.current);
        }
        return;
      }
      if (options?.namespace && options.namespace.length > 0) return;
      const event = parseSubagentEvent(data);
      if (!event) return;
      setDynamicWorkflows((prev) =>
        applySubagentEvent(prev, event, Date.now())
      );
    },
    thread,
  };
  const stream = useStream<StateType>(streamOptions);
  // A run that ends or stops mid-draft or mid-grading leaves no step shown.
  useEffect(() => {
    if (!stream.isLoading) setGoalBusy(null);
  }, [stream.isLoading]);

  // `filterSubagentMessages` is a DeepAgent-only option in the SDK's public
  // type inference, but remote graph clients cannot import the backend agent's
  // phantom TypeScript type. The runtime stream still exposes the documented
  // subagents map, keyed by the parent task tool-call id.
  const subAgentActivity = subAgentStreamsToSteps(
    (
      stream as typeof stream & {
        subagents?: ReadonlyMap<string, { messages: unknown[] }>;
      }
    ).subagents ?? new Map()
  );

  // `stream` is a NEW object every render of `useStream` — depending on it in a
  // `useCallback` makes the callback churn on every stream notification (which
  // fires on each token under fine-grained streaming, e.g. DeepSeek). Any
  // effect that lists such a callback in its deps then re-runs per token,
  // repeatedly hitting React's "Maximum update depth" guard and — pre backend
  // dedup — firing bursts of duplicate `/runs/stream` POSTs. We hold `stream`
  // in a ref that we refresh each render and read `.current.submit(...)` from
  // inside stable callbacks, so downstream callback identity stays constant.
  const streamRef = useRef(stream);
  streamRef.current = stream;

  // Whether the open thread may run here, and on which assistant.
  // The SDK's history runs from the oldest checkpoint to the newest.
  const latestCheckpointMetadata = stream.history?.at(-1)?.metadata as
    | Record<string, unknown>
    | undefined;
  const folders: ThreadFolders | null | undefined = !threadId
    ? null
    : !openMeta || stream.isThreadLoading
    ? undefined
    : threadFolders(openMeta.metadata, latestCheckpointMetadata);
  const binding = threadBinding(
    projects,
    folders,
    CHAT_GRAPHS,
    current?.key ?? null
  );
  // A thread whose own metadata names no folder takes its checkpoint's, so
  // its assistant is that project's too; with its run folder, so a thread
  // working in one stays read-only.
  const checkpointFolder = folders?.workspaceDir ?? null;
  const checkpointRunDir = folders?.runDir ?? null;
  useEffect(() => {
    if (!checkpointFolder) return;
    setThreadMeta((prev) =>
      prev && prev.threadId === threadId && !prev.metadata["workspace_dir"]
        ? {
            ...prev,
            metadata: {
              ...prev.metadata,
              workspace_dir: checkpointFolder,
              ...(checkpointRunDir ? { run_dir: checkpointRunDir } : {}),
            },
          }
        : prev
    );
  }, [checkpointFolder, checkpointRunDir, threadId]);
  // The open thread's own project, registered with its folder in place,
  // whether or not the thread may run here: it is the current one, so the
  // files and a new chat follow it.
  const ownProject =
    threadId && folders?.workspaceDir
      ? findProject(projects, folders.workspaceDir)
      : null;
  const ownKey = ownProject && !ownProject.missing ? ownProject.key : null;
  useEffect(() => {
    if (ownKey) selectProject(ownKey);
  }, [ownKey, selectProject]);
  // A thread working in a run folder names files from that folder.
  const runFolder =
    ownKey && folders?.runDir ? runFolderIn(ownKey, folders.runDir) : null;
  // One gate for every run: a thread that may run here, its assistant for
  // that project, and no project read in progress.
  const canSend =
    threadAssistantId !== "" &&
    canRun(binding) &&
    "key" in binding &&
    binding.key === assistantKey &&
    !refreshing;
  const runStateRef = useRef({ canSend, binding, threadId });
  runStateRef.current = { canSend, binding, threadId };
  // For every run path: check this, and only then change local state and
  // send, in one synchronous block, so the send can't be refused after the
  // caller has acted on it.
  const canRunNow = useCallback(
    () => isReady() && runStateRef.current.canSend,
    [isReady]
  );
  // Every run on the open thread starts here, once canRunNow() said yes:
  // it records the project the run is sent in (and makes it the last used),
  // and a thread with no folder joins that project (the run binds it; its
  // metadata gets the folder so it shows in the project's list). Returns the
  // project's key. Reads only refs and stable setters, so one instance
  // serves every render.
  const startRun = useCallback((): string | null => {
    const run = runStateRef.current;
    const key =
      run.binding.kind === "open" || run.binding.kind === "unbound"
        ? run.binding.key
        : null;
    if (!key) return null;
    const sent = { threadId: run.threadId, key };
    sentInRef.current = sent;
    setSentIn(sent);
    selectProject(key, { remember: true });
    if (run.threadId && run.binding.kind === "unbound") {
      const stamped = run.threadId;
      void stampThreadWorkspace(stamped, key).catch(() => {
        // The next restore stamps it from the run's checkpoint.
      });
      // Stamped once: the thread now reads as bound here.
      setThreadMeta((prev) =>
        prev?.threadId === stamped
          ? { ...prev, metadata: { ...prev.metadata, workspace_dir: key } }
          : prev
      );
    }
    return key;
  }, [selectProject]);

  // The run is over (finished, failed or stopped). The SDK flips `isLoading`
  // back in every case, unlike `onFinish` (success only) and `onError` (also
  // called for a failed history fetch while a run streams).
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (wasLoadingRef.current && !stream.isLoading) retryTracker.reset();
    wasLoadingRef.current = stream.isLoading;
  }, [stream.isLoading, retryTracker]);

  // Times the reasoning of the replies to runs started here (thinkingTimer),
  // from the live stream: `messages` below can lag behind `isLoading`.
  const [thinkingClock] = useState(() =>
    createThinkingClock((message) =>
      streamedModel(
        streamRef.current.getMessagesMetadata(message)?.streamMetadata
      )
    )
  );
  useEffect(() => {
    thinkingClock.observe(stream.messages, stream.isLoading);
  }, [thinkingClock, stream.messages, stream.isLoading]);

  useEffect(() => {
    const previousThreadId = workflowThreadIdRef.current;
    workflowThreadIdRef.current = threadId;
    if (!threadId) {
      setDynamicWorkflows({});
      return;
    }
    const stored = loadThreadWorkflows(threadId);
    setDynamicWorkflows((prev) =>
      previousThreadId !== null && previousThreadId !== threadId
        ? stored
        : mergeWorkflowMaps(stored, prev)
    );
  }, [threadId]);

  const prevWorkflowLoadingRef = useRef(stream.isLoading);
  useEffect(() => {
    const was = prevWorkflowLoadingRef.current;
    prevWorkflowLoadingRef.current = stream.isLoading;
    if (was && !stream.isLoading) {
      setDynamicWorkflows((prev) => finalizeRunning(prev, Date.now()));
    }
  }, [stream.isLoading]);

  useEffect(() => {
    if (!threadId || Object.keys(dynamicWorkflows).length === 0) return;
    const timer = setTimeout(() => {
      saveThreadWorkflows(threadId, dynamicWorkflows);
    }, 1000);
    return () => clearTimeout(timer);
  }, [threadId, dynamicWorkflows]);

  const workflowsFlushRef = useRef<{
    threadId: string | null;
    map: WorkflowMap;
  }>({
    threadId: null,
    map: {},
  });
  workflowsFlushRef.current = { threadId, map: dynamicWorkflows };
  useEffect(
    () => () => {
      const { threadId: tid, map } = workflowsFlushRef.current;
      if (tid && Object.keys(map).length > 0) saveThreadWorkflows(tid, map);
    },
    []
  );

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
  const [fetchedThreadId, setFetchedThreadId] = useState<string | null>(null);
  const recoveryRunRef = useRef(0);
  // Set when the user explicitly abandons the current run via the Stop button.
  // While set, the exposed `interrupt` is forced to `undefined` so NO approval
  // surfaces - not the one on screen, not the next one the aborted run pauses
  // on, whether it arrives via the live `stream.interrupt` or the recovery
  // poll below. Without this, approving one tool call and then hitting Stop
  // drops the user back onto the *next* tool call's approval. Reset when a
  // genuinely new turn starts (`sendMessage` / `resumeInterrupt`).
  //
  // Two forms of the same flag: the ref is read inside the poll's async closure
  // (state would be stale there); the state drives the reactive `interrupt`
  // getter. They are always set/reset together.
  const userAbortedRef = useRef(false);
  const [userAborted, setUserAborted] = useState(false);
  // The turn Stop was pressed on (id of its human message). Stop abandons that
  // run, not whatever runs on the thread afterwards: once the server shows a
  // newer turn — another tab, a cron run — its approvals are not ours to hide.
  const abortedTurnRef = useRef<string | null>(null);
  // The thread the server last confirmed as "not busy, nothing pending" — see
  // `runSettled` below.
  const [settledThreadId, setSettledThreadId] = useState<string | null>(null);
  // The abandon is scoped to the thread Stop was pressed on. ChatProvider is
  // remounted on thread switches today (chatSessionRevision), so this reset is
  // belt-and-braces for any future path that swaps `threadId` inside a mounted
  // instance — without it the recovery poll would mark the next thread's
  // genuine interrupt resolved. `resolvedInterruptKey` is the other half of
  // the same suppression mechanism and the interrupt getter reads it with no
  // threadId guard of its own, so it resets here too.
  useEffect(() => {
    userAbortedRef.current = false;
    abortedTurnRef.current = null;
    setUserAborted(false);
    setResolvedInterruptKey(null);
  }, [threadId]);

  // Per-thread model override. When set, gets folded into
  // `configurable.model` on every `stream.submit` — the backend's
  // `configurable_model` middleware
  // (EvoScientist/middleware/configurable_model.py) is what actually swaps
  // the chat model per request.
  //
  // The persistence dance gets a wrinkle for fresh chats: the thread row
  // doesn't exist server-side until the first `stream.submit` creates it,
  // so we can't write `model_override` into thread metadata yet. We stash
  // any pre-thread pick in `pendingOverrideRef`, fold it into the first
  // run's config via `buildRunConfig`, and write it through to metadata
  // when `threadId` actually shows up. Without this, the user's first
  // message goes to the deployment default even after they picked a model
  // from the empty composer.
  const [modelOverride, setModelOverrideState] = useState<ModelOverride | null>(
    null
  );
  const pendingOverrideRef = useRef<ModelOverride | null>(null);
  const wrotePendingForRef = useRef<string | null>(null);
  useEffect(() => {
    // The skip below is for the thread the pick was written to, until another
    // thread (or a new chat) opens.
    if (wrotePendingForRef.current !== threadId) {
      wrotePendingForRef.current = null;
    }
    if (!threadId) {
      // Don't clobber a pending pre-thread override — `buildRunConfig` still
      // needs to read it for the first send.
      if (!pendingOverrideRef.current) setModelOverrideState(null);
      return;
    }
    // Thread just came into existence (or we switched onto an existing one).
    // If we have a pending pre-thread override, write it through to metadata
    // and keep the local state as-is.
    if (pendingOverrideRef.current) {
      const pending = pendingOverrideRef.current;
      pendingOverrideRef.current = null;
      wrotePendingForRef.current = threadId;
      void (async () => {
        try {
          await setThreadModelOverride(threadId, pending);
        } catch {
          // The local state still reflects the pick; the next `setModelOverride`
          // call (or thread reopen) gets another chance to persist it.
        }
      })();
      return;
    }
    // Otherwise the override is seeded from the thread's metadata below.
  }, [threadId]);
  // Seed the override from the thread's own metadata (fetched once per
  // thread, above), except on the thread a pending pick was just written to.
  useEffect(() => {
    if (!threadId || !openMeta) return;
    if (wrotePendingForRef.current === threadId) return;
    const raw = openMeta.metadata[MODEL_OVERRIDE_METADATA_KEY];
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as { model?: unknown }).model === "string"
    ) {
      const r = raw as { model: string; model_provider?: unknown };
      setModelOverrideState({
        model: r.model,
        model_provider:
          typeof r.model_provider === "string" ? r.model_provider : undefined,
      });
    } else {
      setModelOverrideState(null);
    }
  }, [threadId, openMeta]);

  // Persist + apply locally. When the thread row exists, writes metadata
  // first so a reload keeps the choice. Pre-thread (new chat with no
  // threadId yet), stashes the override in a ref so the next send picks it
  // up via `buildRunConfig` and the thread-id effect can persist it as soon
  // as the row is created server-side.
  const setModelOverride = useCallback(
    async (next: ModelOverride | null) => {
      setModelOverrideState(next);
      if (!threadId) {
        pendingOverrideRef.current = next;
        return;
      }
      pendingOverrideRef.current = null;
      // A pick made here wins over the metadata read when the thread opened,
      // even if that read lands after it.
      wrotePendingForRef.current = threadId;
      // Keep the thread's metadata held here in step, so seeding from it
      // later (e.g. after stamping the folder) can't undo this pick.
      setThreadMeta((prev) =>
        prev?.threadId === threadId
          ? {
              ...prev,
              metadata: {
                ...prev.metadata,
                [MODEL_OVERRIDE_METADATA_KEY]: next,
              },
            }
          : prev
      );
      await setThreadModelOverride(threadId, next);
    },
    [threadId]
  );
  // `stream.interrupt` is a fresh object per access (SDK getter); key the
  // recovery effect on its ID (or value fallback) so a pending interrupt doesn't
  // re-run it per commit.
  const liveInterruptKey = interruptValueKey(coerceInterrupt(stream.interrupt));
  useEffect(() => {
    if (!threadId) {
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setFetchedThreadId(null);
      setResolvedInterruptKey(null);
      setSettledThreadId(null);
      return;
    }
    if (stream.isLoading) {
      recoveryRunRef.current += 1;
      setFetchedInterrupt(undefined);
      setResolvedInterruptKey(null);
      setSettledThreadId(null);
      return;
    }
    // The live stream count at the moment it settled. If the server's persisted
    // state has MORE messages than this, the stream ended early and dropped the
    // tail — either the final assistant text, or the `execute` tool-call message
    // plus its approval interrupt. Either way we backfill from thread state
    // (the same data a thread-switch re-fetch would pull in).
    const baseline = stream.messages.length;
    const recoveryRunId = ++recoveryRunRef.current;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const MAX_TRIES = 15;
    const attempt = async () => {
      tries += 1;
      try {
        const goalRead = ++goalReadRef.current;
        const [state, threadRecord] = await Promise.all([
          client.threads.getState(threadId) as Promise<{
            tasks?: Array<{ interrupts?: unknown[] }>;
            next?: unknown[];
            values?: { messages?: Message[] } & Record<string, unknown>;
          }>,
          client.threads.get(threadId) as Promise<{
            status?: string;
            values?: { messages?: Message[] };
          }>,
        ]);
        if (cancelled || recoveryRunRef.current !== recoveryRunId) return;
        applyGoalRead(goalRead, threadId, state.values);
        const msgs = pickThreadMessages(
          state.values?.messages,
          threadRecord.values?.messages
        );
        const pending = latestTaskInterrupt(state.tasks);
        const stillPending = Array.isArray(state.next) && state.next.length > 0;
        const safePending = normalizePendingInterrupt(pending);
        if (
          userAbortedRef.current &&
          abortedTurnRef.current !== null &&
          Array.isArray(msgs)
        ) {
          const serverTurn = lastHumanMessageId(msgs);
          if (serverTurn !== null && serverTurn !== abortedTurnRef.current) {
            userAbortedRef.current = false;
            abortedTurnRef.current = null;
            setUserAborted(false);
          }
        }
        if (safePending && hasActionableInterrupt(safePending)) {
          // Something is waiting on the user (or was abandoned by them, below):
          // either way this poll says nothing about the calls being dead.
          setSettledThreadId(null);
          if (userAbortedRef.current) {
            // The user hit Stop/Reject on this run: treat it as a real
            // interruption. Don't re-surface the approval the run paused on —
            // mark it resolved so neither the fetched nor the live path renders
            // the card, backfill messages, and stop polling.
            setFetchedInterrupt(undefined);
            setResolvedInterruptKey(
              interruptValueKey(coerceInterrupt(safePending))
            );
            if (Array.isArray(msgs)) {
              setFetchedThreadId(threadId);
              setFetchedMessages(msgs);
            }
            return;
          }
          // Tool-approval interrupt reached — surface it and its matching message
          // snapshot together. Mixing live messages with fetched interrupts is the
          // race that hides approval cards for repeated execute calls.
          setFetchedInterrupt(
            safePending as unknown as typeof stream.interrupt
          );
          setResolvedInterruptKey(null);
          if (Array.isArray(msgs)) {
            setFetchedThreadId(threadId);
            setFetchedMessages(msgs);
          }
          return;
        }
        // No approval is pending. If the server also says the thread is not
        // busy, nothing can still produce a result for a tool call that has none
        // (a cancelled run leaves `next` populated for good, so `next` alone
        // cannot tell). "busy" means the stream merely settled early; a missing
        // status means we don't know — both keep the spinners.
        // Every poll answers afresh — a run started elsewhere can pick the
        // thread up again — and only statuses known to mean "nothing is running"
        // count, so a server with states of its own never reads as finished.
        const serverSettled = SETTLED_THREAD_STATUSES.has(
          threadRecord.status ?? ""
        );
        setSettledThreadId(serverSettled ? threadId : null);
        // Backfill only after the live stream is idle. During active streaming the
        // live message list owns rendering; this recovery loop is for dropped tail
        // state after the stream has settled.
        if (Array.isArray(msgs) && msgs.length > baseline) {
          setFetchedThreadId(threadId);
          setFetchedMessages(msgs);
        }
        if (!stillPending || serverSettled) {
          // A failed/cancelled run can retain `next` after its approval was
          // resolved. The server has no actionable interrupt and is no longer
          // busy, so suppress the stale SDK approval even in that case. Key it
          // by identity so a genuinely new approval still shows.
          setFetchedInterrupt(undefined);
          setResolvedInterruptKey(
            interruptValueKey(coerceInterrupt(stream.interrupt))
          );
          if (Array.isArray(msgs)) {
            setFetchedThreadId(threadId);
            setFetchedMessages(msgs);
          }
          if (!stillPending) return;
        }
        // Keep the bounded follow-up when `next` remains: a run started in
        // another tab can become busy or reach a new approval during this window.
        if (stillPending && tries < MAX_TRIES && !cancelled) {
          timer = setTimeout(attempt, 1000);
        }
      } catch {
        if (
          !cancelled &&
          recoveryRunRef.current === recoveryRunId &&
          tries < MAX_TRIES
        ) {
          timer = setTimeout(attempt, 1000);
        }
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Precise deps on purpose: the whole `stream` object (and `stream.interrupt`
    // itself) is new each render and would loop the getState fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, liveInterruptKey, stream.isLoading, client]);

  const liveInterrupt = coerceInterrupt(
    stream.interrupt
  ) as typeof stream.interrupt;
  const interrupt = userAborted
    ? undefined
    : fetchedThreadId === threadId && fetchedInterrupt
    ? fetchedInterrupt
    : liveInterrupt &&
      (resolvedInterruptKey === null ||
        interruptValueKey(liveInterrupt) !== resolvedInterruptKey)
    ? liveInterrupt
    : undefined;
  // Prefer the backfilled snapshot when it is "ahead" of the live stream — i.e.
  // the stream ended early and dropped the tail. "Ahead" means either MORE
  // messages, or (once settled) the SAME number of messages but MORE total text:
  // the final assistant turn often arrives as an empty/partial AI message with
  // the right count but no content, so a pure length compare would keep showing
  // the blank live version (the bug where the answer only appears after a manual
  // refresh). The equal-count/more-text rule is gated on `!isLoading` so a
  // mid-stream poll snapshot never flickers over the actively updating stream.
  //
  // Once the run has settled AND we have a snapshot, ALWAYS prefer the snapshot.
  // `stream.messages` can carry subgraph noise (streamSubgraphs: true) plus
  // stale per-message metadata from earlier runs, inflating its length above the
  // persisted main-thread state. A pure `>` compare against that bloated count
  // would keep us on the stream — which makes the downstream subgraph-namespace
  // filter (ChatInterface.processedMessages) drop legitimate main-thread
  // history that's only tagged subgraph in stale stream metadata.
  const rawMessages = (() => {
    if (!fetchedMessages || fetchedThreadId !== threadId)
      return stream.messages;
    if (fetchedInterrupt) return fetchedMessages;
    if (!stream.isLoading) return fetchedMessages;
    if (fetchedMessages.length > stream.messages.length) return fetchedMessages;
    if (
      fetchedMessages.length === stream.messages.length &&
      totalTextLength(fetchedMessages) > totalTextLength(stream.messages)
    ) {
      return fetchedMessages;
    }
    return stream.messages;
  })();
  // Defer `messages` so token-stream bursts (per-token setStreamValues calls
  // inside the SDK) become low-priority updates. React 19 coalesces rapid
  // changes and delivers a single commit when the CPU catches up, instead of
  // scheduling one render per SDK notify. Targets the residual max-update-
  // depth trips at run tail, mid-run join on reload, and rapid parallel-tool
  // interrupt bursts - all cases where the SDK emits setStreamValues faster
  // than React can commit and the 1.9.3 RootMessageProjection coalescer
  // doesn't cover (it only batches projection writes, not raw values).
  // Downstream consumers (`processedMessages` memo, auto-report effect,
  // ChatMessage render) see a slightly-lagged messages list under bursts, but
  // the actual displayed content catches up within one animation frame in
  // practice.
  const messages = useDeferredValue(rawMessages);

  // The run's config carries only the per-thread model override. The server
  // layers the assistant's config (its `workspace_dir`) underneath, so a
  // stale assistant held here can't send another folder that would win.
  const buildRunConfig = useCallback(
    (mode: RunMode = "thread") => {
      const configurable: Record<string, unknown> = {};
      if (modelOverride) {
        configurable.model = modelOverride.model;
        if (modelOverride.model_provider) {
          configurable.model_provider = modelOverride.model_provider;
        }
      }
      // The core's grading marker: a thread's goal applies only to runs
      // that carry it, and a resume without it drops a goal review. Sent
      // until the backend is known to lack goals; an older core ignores it.
      if (goalSupported !== false) {
        configurable.rubric_run = { mode, changes: [] };
      }
      return { configurable };
    },
    [modelOverride, goalSupported]
  );

  const sendMessage = useCallback(
    (content: string, options?: { mode?: RunMode }): boolean => {
      if (!canRunNow()) return false;
      const key = startRun();
      const mode = options?.mode ?? "thread";
      lastRunModeRef.current = mode;
      goalEventKeysRef.current = new Set();
      // Drop any settled-run snapshot up front. Otherwise, until `isLoading`
      // flips true (and the effect above clears it), a previous run's
      // `fetchedMessages` can still out-count `stream.messages` and shadow the
      // just-added optimistic user message — making it flicker/vanish.
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setFetchedThreadId(null);
      setResolvedInterruptKey(null);
      userAbortedRef.current = false;
      abortedTurnRef.current = null;
      setUserAborted(false);
      recoveryRunRef.current += 1;
      retryTracker.reset();
      const newMessage: Message = { id: uuidv4(), type: "human", content };
      lastSubmittedHumanIdRef.current = newMessage.id ?? null;
      unsentGoalRef.current = null;
      thinkingClock.runStarting();
      streamRef.current.submit(
        { messages: [newMessage], goal_request: null },
        {
          optimisticValues: (prev) => ({
            messages: [...(prev.messages ?? []), newMessage],
          }),
          config: buildRunConfig(mode),
          // A new thread is created with this metadata, so it is in the
          // folder's list from the first message.
          metadata: key ? { workspace_dir: key } : undefined,
          streamSubgraphs: true,
          streamMode: ["updates"],
          streamResumable: true,
          onDisconnect: "continue",
        }
      );
      // Update thread list immediately when sending a message
      onHistoryRevalidate?.();
      return true;
    },
    [
      buildRunConfig,
      canRunNow,
      onHistoryRevalidate,
      retryTracker,
      startRun,
      thinkingClock,
    ]
  );

  const setFiles = useCallback(
    async (files: Record<string, string>) => {
      if (!threadId) return;
      // Writing state adds a checkpoint without the run's folders.
      if (!canRunNow()) {
        throw new Error("This conversation is read-only here.");
      }
      // TODO: missing a way how to revalidate the internal state
      // I think we do want to have the ability to externally manage the state
      try {
        await client.threads.updateState(threadId, { values: { files } });
      } catch (error) {
        // The backend refuses a write in a project it no longer serves (one
        // removed elsewhere): the list here is stale. Reading it again makes
        // the conversation read-only; the backend's message says why.
        if (getHttpStatus(error) === 409) {
          void refreshProjects();
        }
        throw error;
      }
    },
    [canRunNow, client, refreshProjects, threadId]
  );

  // A /goal request: a thread run with no message (the core drafts the
  // criteria and pauses on a review the user answers with resumeInterrupt).
  const sendGoalRequest = useCallback(
    (request: GoalRequest, text?: string): boolean => {
      if (goalsHere !== true || !canRunNow()) return false;
      const key = startRun();
      lastRunModeRef.current = "thread";
      goalEventKeysRef.current = new Set();
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setFetchedThreadId(null);
      setResolvedInterruptKey(null);
      userAbortedRef.current = false;
      abortedTurnRef.current = null;
      setUserAborted(false);
      recoveryRunRef.current += 1;
      retryTracker.reset();
      lastSubmittedHumanIdRef.current = null;
      unsentGoalRef.current = text?.trim() || null;
      thinkingClock.runStarting();
      streamRef.current.submit(
        { messages: [], goal_request: request },
        {
          config: buildRunConfig("thread"),
          metadata: key ? { workspace_dir: key } : undefined,
          streamSubgraphs: true,
          streamMode: ["updates"],
          streamResumable: true,
          onDisconnect: "continue",
        }
      );
      onHistoryRevalidate?.();
      return true;
    },
    [
      buildRunConfig,
      canRunNow,
      goalsHere,
      onHistoryRevalidate,
      retryTracker,
      startRun,
      thinkingClock,
    ]
  );

  const resumeInterrupt = useCallback(
    (value: any): boolean => {
      if (!canRunNow()) return false;
      startRun();
      goalEventKeysRef.current = new Set();
      // Same as sendMessage: clear the prior snapshot before resuming so a stale
      // fetchedInterrupt/fetchedMessages can't briefly re-surface a resolved
      // approval card or shadow the resumed run's messages.
      setFetchedInterrupt(undefined);
      setFetchedMessages(null);
      setFetchedThreadId(null);
      setResolvedInterruptKey(null);
      userAbortedRef.current = false;
      abortedTurnRef.current = null;
      setUserAborted(false);
      recoveryRunRef.current += 1;
      retryTracker.reset();
      lastSubmittedHumanIdRef.current = null;
      unsentGoalRef.current = null;
      thinkingClock.runStarting();
      streamRef.current.submit(null, {
        command: { resume: value },
        config: buildRunConfig(lastRunModeRef.current ?? "thread"),
        streamSubgraphs: true,
        streamMode: ["updates"],
        streamResumable: true,
        onDisconnect: "continue",
      });
      // Update thread list when resuming from interrupt
      onHistoryRevalidate?.();
      return true;
    },
    [
      buildRunConfig,
      canRunNow,
      onHistoryRevalidate,
      retryTracker,
      startRun,
      thinkingClock,
    ]
  );

  // Abandon the current run when the user hits Stop and hand control back to
  // the composer. `stream.stop()` cancels the run server-side
  // (`action="interrupt"`) and aborts the local reader. The `userAbortedRef`
  // guard in the recovery poll keeps the interrupt the run paused on from
  // being re-surfaced - without it, approving one tool call and then hitting
  // Stop drops the user back onto the next tool call's approval.
  const abortRun = useCallback(() => {
    userAbortedRef.current = true;
    abortedTurnRef.current = lastHumanMessageId(streamRef.current.messages);
    setUserAborted(true);
    lastSubmittedHumanIdRef.current = null;
    unsentGoalRef.current = null;
    retryTracker.reset();
    streamRef.current.stop();
  }, [retryTracker]);

  // Precompute the sidebar labels ("auto_title" + "preview") into thread
  // metadata whenever a run settles, so the sidebar can render off metadata
  // alone. Fires only on the loading -> idle transition (not per-token), then
  // no-ops via `lastWrittenRef` if the values match what was already written
  // in this session. The persist call itself also compares against server
  // metadata before writing, so this is safe across tabs/reloads too.
  //
  // Pre-existing threads (with neither metadata key set) are self-healed by
  // the sidebar fetcher in `useThreads` (fetched once, derived, written
  // back), so they show the right labels even before they get a new turn.
  // `scripts/backfill-thread-previews.mjs` remains as an optional bulk
  // migration for repo checkouts.
  const prevLoadingRef = useRef(false);
  const lastWrittenRef = useRef<{
    threadId: string;
    autoTitle: string | null;
    preview: string | null;
  } | null>(null);
  // `threadId` captured at each `isLoading` rising edge — the thread that
  // owns the run. Persisting below is skipped when it no longer matches the
  // current `threadId`, so an isLoading toggle during sidebar navigation
  // can't write one thread's labels onto another. `null` means the run
  // started pre-thread (new-chat first turn), a legitimate write.
  const runStartThreadIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (stream.isLoading && !prevLoadingRef.current) {
      runStartThreadIdRef.current = threadId;
    }
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = stream.isLoading;
    if (!wasLoading || stream.isLoading || !threadId) return;
    const start = runStartThreadIdRef.current;
    if (start !== null && start !== threadId) return;
    const derived = deriveThreadMetadata(messages);
    if (!derived.autoTitle && !derived.preview) return;
    const last = lastWrittenRef.current;
    if (
      last &&
      last.threadId === threadId &&
      last.autoTitle === derived.autoTitle &&
      last.preview === derived.preview
    ) {
      return;
    }
    void persistThreadDerivedMetadata(threadId, derived)
      .then(() => {
        // Mark as written only on success so a transient failure retries on
        // the next idle transition (the derived values rarely change, so a
        // pre-write mark would suppress retries for the whole session).
        lastWrittenRef.current = { threadId, ...derived };
        onHistoryRevalidate?.();
      })
      .catch(() => {
        // Non-critical: sidebar label stays stale; retried next turn.
      });
  }, [stream.isLoading, threadId, messages, onHistoryRevalidate]);

  return {
    stream,
    todos: stream.values.todos ?? [],
    files: stream.values.files ?? {},
    email: stream.values.email,
    asyncTasks: stream.values.async_tasks ?? {},
    summarizationEvent: parseSummarizationEvent(
      stream.values._summarization_event
    ),
    ui: stream.values.ui,
    setFiles,
    messages,
    isLoading: stream.isLoading,
    // Nothing can still produce a result for this thread's unanswered tool
    // calls: the user pressed Stop, or the server confirmed the thread is not
    // busy with no approval pending. Drives "stopped" instead of a spinner.
    runSettled:
      !!threadId &&
      !stream.isLoading &&
      (userAborted || settledThreadId === threadId),
    isThreadLoading: stream.isThreadLoading,
    /** The graph the open thread runs on. */
    threadGraph,

    /** Whether the open thread runs here, and why not. */
    binding,
    /** The chat's project: the one it runs in, else the open thread's own
     *  registered project (a read-only thread's too); null for none. */
    projectKey: assistantKey ?? ownKey,
    /** The open thread's run folder inside its project, which its file
     *  links name files from; null for none. */
    runFolder,
    /** Whether a run could start, for rendering and effect dependencies. */
    canSend,
    /** Every run path checks this first, at the moment it acts. */
    canRunNow,
    /** Where a refused message goes back to: the composer. */
    setRefusalHandler,
    interrupt,
    sendMessage,
    abortRun,
    resumeInterrupt,
    subAgentActivity,
    dynamicWorkflows,
    modelOverride,
    setModelOverride,
    /** Whether the backend takes /goal; undefined until known. */
    goalSupported: goalsHere,
    // A new chat runs on the chat graph: what a /goal text means there.
    chatGoalSupported: goalSupported,
    sendGoalRequest,
    /** The open thread's goal, from thread state. */
    goal: goalState && goalState.threadId === threadId ? goalState.goal : null,
    goalBusy,
    /** The open thread's latest grading. */
    rubricVerdict:
      goalState && goalState.threadId === threadId ? goalState.verdict : null,
  };
}
