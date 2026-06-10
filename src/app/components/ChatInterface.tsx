"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  FormEvent,
  Fragment,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Square,
  ArrowUp,
  CheckCircle,
  Clock,
  Circle,
  FileIcon,
  FolderOpen,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Paperclip,
  X,
} from "lucide-react";
import { ChatMessage } from "@/app/components/ChatMessage";
import {
  AskUserInterrupt,
  type AskUserQuestion,
} from "@/app/components/AskUserInterrupt";
import type {
  TodoItem,
  ToolCall,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Assistant, Message } from "@langchain/langgraph-sdk";
import { extractStringFromMessageContent } from "@/app/utils/utils";
import { useChatContext } from "@/providers/ChatProvider";
import { cn } from "@/lib/utils";
import { formatModel } from "@/lib/model";
import {
  getThreadAutoApprove,
  setThreadAutoApprove,
  migrateNewThreadAutoApprove,
} from "@/lib/autoApprove";
import {
  agentLabel,
  asyncTaskReportKey,
  asyncUpdateMatchesTask,
  asyncUpdateMessageKey,
  countRunning,
  formatAsyncUpdateMessage,
  isTerminalStatus,
  type MainChatReporter,
} from "@/lib/asyncAgents";
import { useAsyncAgents } from "@/app/hooks/useAsyncAgents";
import { useAutoNotify } from "@/app/hooks/useAutoNotify";
import {
  getThreadAutoNotifyReportedKeys,
  initializeThreadAutoNotifyReports,
  isThreadAutoNotifyInitialized,
  markThreadAutoNotifyReported,
} from "@/lib/autoNotify";
import { lastTextOf, type SubAgentStep } from "@/lib/subAgentActivity";
import { useStickToBottom } from "use-stick-to-bottom";
import { FilesPopover } from "@/app/components/TasksFilesSidebar";
import { WorkspacePanel } from "@/app/components/WorkspacePanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQueryState } from "nuqs";
import { toast } from "sonner";

interface ChatInterfaceProps {
  assistant: Assistant | null;
  // Open the right inspector on its Agents tab (composer "agents running" pulse).
  onShowAgents?: () => void;
  // Register a "submit a message on THIS (main) thread" function up to page so
  // the Agents board can loop an async result back to the main agent. Returns
  // false if the main chat is mid-run (can't take a turn). Cleared on unmount.
  onNotifyReady?: (notify: MainChatReporter | null) => void;
}

const SUGGESTED_PROMPTS = [
  "Survey recent papers on a topic",
  "Design an experiment plan",
  "Analyze workspace files",
];

interface UploadedWorkspaceFile {
  name: string;
  path: string;
  size: number;
}

function getMessageToolCalls(message: Message): Array<{
  id?: string;
  name: string;
  args: Record<string, unknown>;
}> {
  const messageWithTools = message as Message & {
    tool_calls?: Array<{ name?: string }>;
  };
  const toolCalls: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    type?: string;
    args?: unknown;
    input?: unknown;
  }> = [];

  if (
    message.additional_kwargs?.tool_calls &&
    Array.isArray(message.additional_kwargs.tool_calls)
  ) {
    toolCalls.push(...message.additional_kwargs.tool_calls);
  } else if (
    messageWithTools.tool_calls &&
    Array.isArray(messageWithTools.tool_calls)
  ) {
    toolCalls.push(
      ...messageWithTools.tool_calls.filter(
        (toolCall: { name?: string }) => toolCall.name !== ""
      )
    );
  } else if (Array.isArray(message.content)) {
    toolCalls.push(
      ...message.content.filter(
        (block: { type?: string }) => block.type === "tool_use"
      )
    );
  }

  return toolCalls.map((toolCall) => {
    const rawArgs =
      toolCall.function?.arguments || toolCall.args || toolCall.input || {};
    return {
      id: toolCall.id,
      name: toolCall.function?.name || toolCall.name || toolCall.type || "",
      args:
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as Record<string, unknown>)
          : {},
    };
  });
}

const getStatusIcon = (status: TodoItem["status"], className?: string) => {
  switch (status) {
    case "completed":
      return (
        <CheckCircle
          size={16}
          className={cn("text-[var(--color-success)]", className)}
        />
      );
    case "in_progress":
      return (
        <Clock
          size={16}
          className={cn("text-[var(--color-warning)]", className)}
        />
      );
    default:
      return (
        <Circle
          size={16}
          className={cn("text-[var(--color-text-tertiary)]", className)}
        />
      );
  }
};

export const ChatInterface = React.memo<ChatInterfaceProps>(
  ({ assistant, onShowAgents, onNotifyReady }) => {
    const [metaOpen, setMetaOpen] = useState<
      "tasks" | "files" | "workspace" | null
    >(null);
    const tasksContainerRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const uploadInputRef = useRef<HTMLInputElement | null>(null);

    const [input, setInput] = useState("");
    const [pendingFiles, setPendingFiles] = useState<UploadedWorkspaceFile[]>(
      []
    );
    const [isUploadingFiles, setIsUploadingFiles] = useState(false);
    const [threadId] = useQueryState("threadId");
    // Auto-approve is per-thread and persisted (see lib/autoApprove): it follows
    // the conversation across view switches (Skills/Memory unmount this), thread
    // switches, and reloads. Seed from storage for whatever thread is active on
    // mount so returning from another view restores the right setting.
    const [autoApprove, setAutoApproveState] = useState(() =>
      getThreadAutoApprove(threadId)
    );
    const [autoApproveDialogOpen, setAutoApproveDialogOpen] = useState(false);
    const autoApprovedRef = useRef<unknown>(null);
    const previousThreadIdRef = useRef(threadId);
    const migrateAutoApproveForCreatedThreadRef = useRef(false);
    const { scrollRef, contentRef, scrollToBottom } = useStickToBottom();

    const {
      stream,
      messages,
      todos,
      files,
      ui,
      setFiles,
      isLoading,
      isThreadLoading,
      interrupt,
      sendMessage,
      stopStream,
      resumeInterrupt,
      subAgentActivity,
      asyncTasks,
    } = useChatContext();

    // Count of background async sub-agents (writing / data-analysis) still
    // running — drives the composer's "agents running" pulse. We poll each task's
    // REAL run status (via useAsyncAgents) rather than trusting the conversation
    // state's cached `status`, which only updates when the agent checks and would
    // otherwise keep the pulse on forever. Only polls when tasks actually exist.
    const hasAsyncTasks = Object.keys(asyncTasks ?? {}).length > 0;
    const { tasks: liveAgentTasks } = useAsyncAgents(threadId, {
      enabled: hasAsyncTasks,
    });
    const runningAgents = useMemo(
      () => countRunning(liveAgentTasks),
      [liveAgentTasks]
    );

    // Auto-report: when on for this thread, a sub-agent that FINISHES while we're
    // watching is looped back to the main agent automatically (same signal as the
    // manual "Notify main chat" button — rendered as a system pill). We baseline
    // tasks already terminal at mount / when the toggle is switched on so we never
    // replay old completions, and only inject while the main chat is idle (one at
    // a time; isLoading gates the rest until the agent finishes the turn).
    const [autoNotify] = useAutoNotify(threadId);
    // Latch covering the gap between submitting an auto-report and `isLoading`
    // flipping true — without it a poll in that window could fire a SECOND report
    // and collide on the main thread. Cleared once the run is confirmed running.
    const autoFireInFlightRef = useRef(false);

    useEffect(() => {
      autoFireInFlightRef.current = false;
    }, [threadId]);

    // Once a run is actually in flight (isLoading true — from a user message, the
    // agent's own turn, or our auto-report), release the latch: the isLoading gate
    // now governs, and the next queued report fires when the thread next goes idle.
    useEffect(() => {
      if (isLoading) autoFireInFlightRef.current = false;
    }, [isLoading]);

    useEffect(() => {
      if (!liveAgentTasks || liveAgentTasks.length === 0) return;
      if (!threadId || !autoNotify) return;
      // One-time migration/baseline: existing terminal tasks predate the setting
      // and must not replay when this feature first appears or is restored.
      if (!isThreadAutoNotifyInitialized(threadId)) {
        initializeThreadAutoNotifyReports(
          threadId,
          liveAgentTasks
            .filter((task) => isTerminalStatus(task.liveStatus))
            .map(asyncTaskReportKey)
        );
        return;
      }
      // Don't fire when: off; the thread is busy (the agent's own turn takes the
      // slot); a report we just sent hasn't started yet; or the USER is composing
      // a query (draft text) — their message has priority, so we hold the queue
      // until the composer is clear. Pending completions stay unreported (= the
      // queue) and drain one per idle window.
      if (isLoading || autoFireInFlightRef.current || input.trim()) return;
      const reportedKeys = getThreadAutoNotifyReportedKeys(threadId);
      for (const t of liveAgentTasks) {
        if (!isTerminalStatus(t.liveStatus)) continue;
        const key = asyncTaskReportKey(t);
        if (reportedKeys.has(key)) continue;
        if (
          messages.some(
            (message) =>
              message.type === "human" &&
              asyncUpdateMatchesTask(
                extractStringFromMessageContent(message),
                t
              )
          )
        ) {
          markThreadAutoNotifyReported(threadId, key);
          continue;
        }
        autoFireInFlightRef.current = true;
        markThreadAutoNotifyReported(threadId, key);
        sendMessage(formatAsyncUpdateMessage(t));
        toast.success(
          `Auto-reported ${agentLabel(t.agent_name)} to the main chat.`
        );
        break; // one per idle window; the rest fire once this turn settles
      }
    }, [
      liveAgentTasks,
      autoNotify,
      isLoading,
      input,
      messages,
      sendMessage,
      threadId,
    ]);

    // Re-engage stick-to-bottom whenever a new run starts (sending a message or
    // resuming an interrupt → isLoading flips true). Without this, if the user had
    // drifted even slightly off the bottom after the previous answer, a short new
    // reply would render below the fold and look like nothing happened.
    useEffect(() => {
      if (isLoading) void scrollToBottom();
    }, [isLoading, scrollToBottom]);

    // Register a "notify the main agent" hook up to page (Agents board → "Notify
    // main chat" loops an async result back here). A ref keeps the latest
    // sendMessage/isLoading so the once-registered closure always reads current
    // values. Returns false if a run is in flight (the agent can't take a turn).
    const notifyStateRef = useRef({
      sendMessage,
      isLoading,
      messages,
      threadId,
    });
    notifyStateRef.current = { sendMessage, isLoading, messages, threadId };
    const onNotifyReadyRef = useRef(onNotifyReady);
    onNotifyReadyRef.current = onNotifyReady;
    useEffect(() => {
      const notify: MainChatReporter = (task, expectedThreadId) => {
        const current = notifyStateRef.current;
        if (current.threadId !== expectedThreadId) return "wrong-thread";
        if (current.isLoading) return "busy";
        if (
          current.messages.some(
            (message) =>
              message.type === "human" &&
              asyncUpdateMatchesTask(
                extractStringFromMessageContent(message),
                task
              )
          )
        ) {
          return "duplicate";
        }
        markThreadAutoNotifyReported(
          expectedThreadId,
          asyncTaskReportKey(task)
        );
        current.sendMessage(formatAsyncUpdateMessage(task));
        return "sent";
      };
      onNotifyReadyRef.current?.(notify);
      return () => onNotifyReadyRef.current?.(null);
    }, []);

    // The model behind the latest assistant reply (read from message metadata).
    // Token/context usage is intentionally NOT shown — the backend doesn't persist
    // usage_metadata, so it isn't reliably available here.
    const currentModel = useMemo(() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type !== "ai") continue;
        const rm = m.response_metadata as Record<string, unknown> | undefined;
        const info = formatModel(
          rm?.model_name ?? rm?.model,
          rm?.model_provider
        );
        if (info) return info;
      }
      return null;
    }, [messages]);

    // Bind captured sub-agent activity (keyed by subgraph namespace) to each task
    // tool call → its live steps. B': match a finished sub-agent to a task by its
    // final text == the task's result; assign still-running sub-agents to the
    // remaining task calls in order. Returns { taskToolCallId: SubAgentStep[] }.
    const subAgentSteps = useMemo(() => {
      const out: Record<string, SubAgentStep[]> = {};
      const nsKeys = Object.keys(subAgentActivity);
      if (nsKeys.length === 0) return out;

      const taskIds: string[] = [];
      const results: Record<string, string> = {};
      for (const m of messages) {
        if (m.type === "ai") {
          const tcs = (m as { tool_calls?: { id?: string; name?: string }[] })
            .tool_calls;
          for (const tc of tcs ?? []) {
            if (tc.name === "task" && tc.id) taskIds.push(tc.id);
          }
        } else if (m.type === "tool") {
          const id = (m as { tool_call_id?: string }).tool_call_id;
          if (id) results[id] = extractStringFromMessageContent(m);
        }
      }

      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const claimed = new Set<string>();
      // 1) Finished tasks: match by output text.
      for (const id of taskIds) {
        const r = norm(results[id] ?? "");
        if (!r) continue;
        const key = nsKeys.find((k) => {
          if (claimed.has(k)) return false;
          const last = norm(lastTextOf(subAgentActivity[k]));
          return last !== "" && (r.includes(last) || last.includes(r));
        });
        if (key) {
          out[id] = subAgentActivity[key];
          claimed.add(key);
        }
      }
      // 2) Running tasks (no result yet): take remaining namespaces in order.
      const remaining = nsKeys.filter((k) => !claimed.has(k));
      let ri = 0;
      for (const id of taskIds) {
        if (out[id] || results[id]) continue;
        if (ri < remaining.length) out[id] = subAgentActivity[remaining[ri++]];
      }
      return out;
    }, [messages, subAgentActivity]);

    // While the agent waits on an *actionable* interrupt (approval or ask_user),
    // lock the composer so the user answers via the in-message controls — a free
    // message would cancel the pending tool call and corrupt the thread.
    // A bare/leftover interrupt value (e.g. after Stop) must NOT lock the input.
    const interruptValue = interrupt?.value as
      | { type?: string; action_requests?: unknown[] }
      | undefined;
    const hasPendingInterrupt =
      interruptValue?.type === "ask_user" ||
      (Array.isArray(interruptValue?.action_requests) &&
        interruptValue.action_requests.length > 0);
    const submitDisabled = isLoading || !assistant || hasPendingInterrupt;
    const enableAutoApprove = useCallback(() => {
      setAutoApproveState(true);
      setThreadAutoApprove(threadId, true);
      setAutoApproveDialogOpen(false);
    }, [threadId]);

    const turnOffAutoApprove = useCallback(() => {
      setAutoApproveState(false);
      setThreadAutoApprove(threadId, false);
      setAutoApproveDialogOpen(false);
      autoApprovedRef.current = null;
    }, [threadId]);

    // Follow the thread: when the active thread changes, load THAT thread's saved
    // auto-approve instead of resetting. The null→real-id transition is the new
    // chat getting created on its first message — carry its sentinel setting over.
    useEffect(() => {
      const previousThreadId = previousThreadIdRef.current;
      if (previousThreadId === threadId) return;

      if (
        previousThreadId === null &&
        threadId !== null &&
        migrateAutoApproveForCreatedThreadRef.current
      ) {
        migrateNewThreadAutoApprove(threadId);
      } else if (previousThreadId === null && threadId !== null) {
        // The user selected an existing research from New Chat before sending.
        // Do not leak the pending-new-chat auto-approve sentinel onto that thread.
        setThreadAutoApprove(null, false);
      }

      setAutoApproveState(getThreadAutoApprove(threadId));
      autoApprovedRef.current = null;
      setAutoApproveDialogOpen(false);
      setPendingFiles([]);
      migrateAutoApproveForCreatedThreadRef.current = false;
      previousThreadIdRef.current = threadId;
    }, [threadId]);

    const handleFilesSelected = useCallback(
      async (event: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (selectedFiles.length === 0) return;

        setIsUploadingFiles(true);
        try {
          const formData = new FormData();
          selectedFiles.forEach((file) => formData.append("files", file));
          const response = await fetch("/api/workspace/upload", {
            method: "POST",
            body: formData,
          });
          const data = (await response.json()) as {
            files?: UploadedWorkspaceFile[];
            error?: string;
          };
          if (!response.ok || !data.files) {
            throw new Error(data.error || "Failed to upload files.");
          }
          setPendingFiles((currentFiles) => [...currentFiles, ...data.files!]);
          toast.success(
            `${data.files.length} file${
              data.files.length === 1 ? "" : "s"
            } uploaded to the workspace.`
          );
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Failed to upload files."
          );
        } finally {
          setIsUploadingFiles(false);
        }
      },
      []
    );

    const removePendingFile = useCallback((filePath: string) => {
      setPendingFiles((currentFiles) =>
        currentFiles.filter((file) => file.path !== filePath)
      );
    }, []);

    const handleSubmit = useCallback(
      (e?: FormEvent) => {
        if (e) {
          e.preventDefault();
        }
        const messageText = input.trim();
        if (!messageText || isLoading || isUploadingFiles || submitDisabled)
          return;
        migrateAutoApproveForCreatedThreadRef.current =
          threadId === null && autoApprove;
        const workspaceFiles =
          pendingFiles.length > 0
            ? `\n\nWorkspace files uploaded for this request:\n${pendingFiles
                .map((file) => `- ${file.path}`)
                .join("\n")}`
            : "";
        sendMessage(`${messageText}${workspaceFiles}`);
        setInput("");
        setPendingFiles([]);
      },
      [
        input,
        autoApprove,
        isLoading,
        isUploadingFiles,
        pendingFiles,
        sendMessage,
        setInput,
        submitDisabled,
        threadId,
      ]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (submitDisabled) return;
        // Don't submit while an IME is composing (e.g. pressing Enter to pick a
        // Chinese/Japanese/Korean candidate must confirm text, not send).
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
      },
      [handleSubmit, submitDisabled]
    );

    // Pull a previous user message back into the composer to edit/resend it,
    // placing the cursor at the end so the user can keep typing.
    const handleEditMessage = useCallback((content: string) => {
      setInput(content);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(content.length, content.length);
        }
      });
    }, []);

    const handleSuggestedPrompt = useCallback((prompt: string) => {
      setInput(prompt);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, []);

    // Auto-approve: when enabled, approve any pending tool-execution interrupt
    // for the rest of this conversation (each interrupt is handled once).
    useEffect(() => {
      if (!autoApprove) return;
      const ir = interrupt;
      const actionRequests =
        ir?.value && ((ir.value as any)["action_requests"] as unknown[]);
      if (
        !ir ||
        !Array.isArray(actionRequests) ||
        actionRequests.length === 0
      ) {
        autoApprovedRef.current = null;
        return;
      }
      if (autoApprovedRef.current === ir) return;
      autoApprovedRef.current = ir;
      resumeInterrupt({
        decisions: actionRequests.map(() => ({ type: "approve" })),
      });
    }, [autoApprove, interrupt, resumeInterrupt]);

    // ask_user: the agent is asking the user structured questions.
    const askUserQuestions = useMemo<AskUserQuestion[] | null>(() => {
      const value = interrupt?.value as
        | { type?: string; questions?: AskUserQuestion[] }
        | undefined;
      if (value?.type === "ask_user" && Array.isArray(value.questions)) {
        return value.questions;
      }
      return null;
    }, [interrupt]);

    const handleAskUserSubmit = useCallback(
      (answers: string[]) => {
        resumeInterrupt({ status: "answered", answers });
      },
      [resumeInterrupt]
    );

    const handleAskUserCancel = useCallback(() => {
      resumeInterrupt({ status: "cancelled" });
    }, [resumeInterrupt]);

    // TODO: can we make this part of the hook?
    const processedMessages = useMemo(() => {
      /*
     1. Loop through all messages
     2. For each AI message, add the AI message, and any tool calls to the messageMap
     3. For each tool message, find the corresponding tool call in the messageMap and update the status and output
    */
      const messageMap = new Map<
        string,
        { message: Message; toolCalls: ToolCall[] }
      >();
      // Sub-agent (subgraph) messages stream in alongside the main conversation
      // when streamSubgraphs is on. They carry a NESTED langgraph_checkpoint_ns
      // ("tools:<id>|…") while the main agent's own messages are single-segment.
      // Keep them OUT of the main flow — they render under each sub-agent block's
      // "Steps" instead. (streamMetadata is live-only; once complete these messages
      // aren't in thread state anyway.)
      const seenAsyncUpdates = new Set<string>();
      const visibleMessages = messages.filter((message: Message) => {
        const meta = stream.getMessagesMetadata(message)?.streamMetadata;
        const ns = meta?.["langgraph_checkpoint_ns"];
        if (typeof ns === "string" && ns.includes("|")) return false;
        if (message.type !== "human") return true;
        const key = asyncUpdateMessageKey(
          extractStringFromMessageContent(message)
        );
        if (!key) return true;
        if (seenAsyncUpdates.has(key)) return false;
        seenAsyncUpdates.add(key);
        return true;
      });
      visibleMessages.forEach((message: Message) => {
        if (message.type === "ai") {
          const toolCallsWithStatus = getMessageToolCalls(message)
            // The auxiliary tool-selector's internal `ToolSelectionResponse` call
            // has no result and isn't HITL-gated. Surface it only as a transient
            // spinner WHILE the run is actively selecting; hide it once the run
            // pauses on an interrupt or settles. Otherwise the execute approval's
            // "interrupted" icon leaks onto it (it never gets a result to clear)
            // and it lingers instead of disappearing.
            .filter(
              (toolCall) =>
                toolCall.name !== "ToolSelectionResponse" ||
                (isLoading && !interrupt)
            )
            .map((toolCall, toolCallIndex) => {
              const name = toolCall.name || "unknown";
              return {
                id:
                  toolCall.id ||
                  `${message.id ?? "ai-message"}-tool-${toolCallIndex}-${name}`,
                name,
                args: toolCall.args,
                // The selector call only survives the filter above while the run is
                // actively selecting (!interrupt), so this resolves to a spinner for
                // it without a special case.
                status: interrupt ? "interrupted" : ("pending" as const),
              } as ToolCall;
            });
          messageMap.set(message.id!, {
            message,
            toolCalls: toolCallsWithStatus,
          });
        } else if (message.type === "tool") {
          const toolCallId = message.tool_call_id;
          if (!toolCallId) {
            return;
          }
          for (const [, data] of messageMap.entries()) {
            const toolCallIndex = data.toolCalls.findIndex(
              (tc: ToolCall) => tc.id === toolCallId
            );
            if (toolCallIndex === -1) {
              continue;
            }
            data.toolCalls[toolCallIndex] = {
              ...data.toolCalls[toolCallIndex],
              status: "completed" as const,
              result: extractStringFromMessageContent(message),
            };
            break;
          }
        } else if (message.type === "human") {
          messageMap.set(message.id!, {
            message,
            toolCalls: [],
          });
        }
      });
      const processedArray = Array.from(messageMap.values());
      return processedArray.map((data, index) => {
        const prevMessage =
          index > 0 ? processedArray[index - 1].message : null;
        return {
          ...data,
          showAvatar: data.message.type !== prevMessage?.type,
        };
      });
    }, [messages, interrupt, isLoading, stream]);

    const groupedTodos = {
      in_progress: todos.filter((t) => t.status === "in_progress"),
      pending: todos.filter((t) => t.status === "pending"),
      completed: todos.filter((t) => t.status === "completed"),
    };

    const hasTasks = todos.length > 0;
    const hasFiles = Object.keys(files).length > 0;

    // Ordered list of pending tool-approval requests from the interrupt. We hand
    // ChatMessage the ORDER (not a name-keyed map) so two calls to the same tool
    // in one turn (e.g. two `execute`) each bind to their OWN request/args instead
    // of both collapsing onto the last one. `Array.isArray` guards a malformed
    // payload — a non-array `action_requests` here would otherwise throw and blank
    // the whole page.
    const actionRequests: ActionRequest[] = useMemo(() => {
      const raw =
        interrupt?.value && (interrupt.value as any)["action_requests"];
      return Array.isArray(raw) ? (raw as ActionRequest[]) : [];
    }, [interrupt]);
    const [submittedActionRequestKeys, setSubmittedActionRequestKeys] =
      useState<Set<string>>(() => new Set());
    useEffect(() => {
      if (actionRequests.length === 0) {
        setSubmittedActionRequestKeys(new Set());
      }
    }, [actionRequests.length]);
    const markActionRequestSubmitted = useCallback((key: string) => {
      setSubmittedActionRequestKeys((current) => {
        const next = new Set(current);
        next.add(key);
        return next;
      });
    }, []);

    const reviewConfigsMap: Map<string, ReviewConfig> | null = useMemo(() => {
      const reviewConfigs =
        interrupt?.value && (interrupt.value as any)["review_configs"];
      if (!Array.isArray(reviewConfigs)) return new Map<string, ReviewConfig>();
      const entries: Array<readonly [string, ReviewConfig]> = [];
      for (const rc of reviewConfigs as ReviewConfig[]) {
        const actionName = rc.actionName ?? rc.action_name;
        if (!actionName) continue;
        entries.push([
          actionName,
          {
            actionName,
            allowedDecisions: rc.allowedDecisions ?? rc.allowed_decisions,
          },
        ]);
      }
      return new Map<string, ReviewConfig>(entries);
    }, [interrupt]);

    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <Dialog
          open={autoApproveDialogOpen}
          onOpenChange={setAutoApproveDialogOpen}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Enable Auto-approve?</DialogTitle>
              <DialogDescription>
                EvoScientist will run tool actions in this research without
                asking you to review each one. Turn this on only when you trust
                the current task and deployment.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <p>
                Auto-approve stays on for this research only — it follows this
                conversation across views and reloads, and other research keeps
                its own setting. Turn it off here anytime.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setAutoApproveDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={enableAutoApprove}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                Enable Auto-approve
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
          ref={scrollRef}
        >
          <div
            className="mx-auto w-full max-w-[960px] px-4 pb-4 pt-3 sm:px-5"
            ref={contentRef}
          >
            {isThreadLoading ? (
              <div className="flex items-center justify-center p-8">
                <p className="text-muted-foreground">Loading…</p>
              </div>
            ) : (
              <>
                {processedMessages.length === 0 && !isLoading && (
                  <div className="flex min-h-[42vh] flex-col items-center justify-center px-3 text-center">
                    <h2 className="text-pretty text-lg font-semibold sm:text-xl">
                      Start Research
                    </h2>
                    <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                      Ask EvoScientist to review literature, inspect workspace
                      files, or plan the next experiment.
                    </p>
                    <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
                      {SUGGESTED_PROMPTS.map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          onClick={() => handleSuggestedPrompt(prompt)}
                          className="max-w-full rounded-full border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:border-[var(--color-border)] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {processedMessages.map((data, index) => {
                  const messageUi = ui?.filter(
                    (u: any) => u.metadata?.message_id === data.message.id
                  );
                  const isLastMessage = index === processedMessages.length - 1;
                  return (
                    <ChatMessage
                      key={data.message.id}
                      message={data.message}
                      toolCalls={data.toolCalls}
                      isLoading={isLoading}
                      actionRequests={
                        isLastMessage ? actionRequests : undefined
                      }
                      submittedActionRequestKeys={submittedActionRequestKeys}
                      onActionRequestSubmitted={markActionRequestSubmitted}
                      reviewConfigsMap={
                        isLastMessage ? reviewConfigsMap : undefined
                      }
                      ui={messageUi}
                      stream={stream}
                      onResumeInterrupt={resumeInterrupt}
                      graphId={assistant?.graph_id}
                      onEditMessage={handleEditMessage}
                      autoApprove={autoApprove}
                      subAgentSteps={subAgentSteps}
                    />
                  );
                })}
                {askUserQuestions && (
                  <div className="mt-4">
                    <AskUserInterrupt
                      questions={askUserQuestions}
                      onSubmit={handleAskUserSubmit}
                      onCancel={handleAskUserCancel}
                      isLoading={isLoading}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex-shrink-0 bg-background">
          <div
            className={cn(
              "mb-2 flex flex-shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-background sm:mb-4",
              "mx-auto w-[calc(100%-16px)] max-w-[960px] transition-colors duration-200 ease-in-out sm:w-[calc(100%-24px)]",
              "focus-within:ring-2 focus-within:ring-ring"
            )}
          >
            {/* Always rendered: the Workspace tab is available even with no tasks
              or state files yet. */}
            {
              <div className="flex max-h-60 flex-col overflow-y-auto border-b border-border bg-sidebar empty:hidden sm:max-h-72">
                {!metaOpen && (
                  <>
                    {(() => {
                      const activeTask = todos.find(
                        (t) => t.status === "in_progress"
                      );

                      const totalTasks = todos.length;
                      const remainingTasks =
                        totalTasks - groupedTodos.pending.length;
                      const isCompleted = totalTasks === remainingTasks;

                      const tasksTrigger = (() => {
                        if (!hasTasks) return null;
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setMetaOpen((prev) =>
                                prev === "tasks" ? null : "tasks"
                              )
                            }
                            className="grid w-full cursor-pointer grid-cols-[auto_auto_1fr] items-center gap-2.5 px-3 py-2.5 text-left sm:px-4"
                            aria-expanded={metaOpen === "tasks"}
                          >
                            {(() => {
                              if (isCompleted) {
                                return [
                                  <CheckCircle
                                    key="icon"
                                    size={16}
                                    className="text-[var(--color-success)]"
                                  />,
                                  <span
                                    key="label"
                                    className="ml-[1px] min-w-0 truncate text-sm"
                                  >
                                    All tasks completed
                                  </span>,
                                ];
                              }

                              if (activeTask != null) {
                                return [
                                  <div key="icon">
                                    {getStatusIcon(activeTask.status)}
                                  </div>,
                                  <span
                                    key="label"
                                    className="ml-[1px] min-w-0 truncate text-sm"
                                  >
                                    Task{" "}
                                    {totalTasks - groupedTodos.pending.length}{" "}
                                    of {totalTasks}
                                  </span>,
                                  <span
                                    key="content"
                                    className="min-w-0 gap-2 truncate text-sm text-muted-foreground"
                                  >
                                    {activeTask.content}
                                  </span>,
                                ];
                              }

                              return [
                                <Circle
                                  key="icon"
                                  size={16}
                                  className="text-[var(--color-text-tertiary)]"
                                />,
                                <span
                                  key="label"
                                  className="ml-[1px] min-w-0 truncate text-sm"
                                >
                                  Task{" "}
                                  {totalTasks - groupedTodos.pending.length} of{" "}
                                  {totalTasks}
                                </span>,
                              ];
                            })()}
                          </button>
                        );
                      })();

                      const filesTrigger = (() => {
                        if (!hasFiles) return null;
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setMetaOpen((prev) =>
                                prev === "files" ? null : "files"
                              )
                            }
                            className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm sm:px-4"
                            aria-expanded={metaOpen === "files"}
                          >
                            <FileIcon size={16} />
                            Files (State)
                            <span className="h-4 min-w-4 rounded-full bg-[var(--brand-solid)] px-0.5 text-center text-[10px] leading-[16px] text-[var(--brand-foreground)]">
                              {Object.keys(files).length}
                            </span>
                          </button>
                        );
                      })();

                      const workspaceTrigger = (
                        <button
                          type="button"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "workspace" ? null : "workspace"
                            )
                          }
                          className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm sm:px-4"
                          aria-expanded={metaOpen === "workspace"}
                          aria-label="Open workspace"
                        >
                          <FolderOpen
                            size={16}
                            aria-hidden="true"
                          />
                          <span>Workspace</span>
                        </button>
                      );

                      return (
                        <div className="flex items-center">
                          <div className="min-w-0 flex-1">{tasksTrigger}</div>
                          {filesTrigger}
                          {workspaceTrigger}
                        </div>
                      );
                    })()}
                  </>
                )}

                {metaOpen && (
                  <>
                    <div className="sticky top-0 flex items-stretch bg-sidebar text-sm">
                      {hasTasks && (
                        <button
                          type="button"
                          className="py-2.5 pr-4 first:pl-3 aria-expanded:font-semibold sm:first:pl-4"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "tasks" ? null : "tasks"
                            )
                          }
                          aria-expanded={metaOpen === "tasks"}
                        >
                          Tasks
                        </button>
                      )}
                      {hasFiles && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 py-2.5 pr-4 first:pl-3 aria-expanded:font-semibold sm:first:pl-4"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "files" ? null : "files"
                            )
                          }
                          aria-expanded={metaOpen === "files"}
                        >
                          Files (State)
                          <span className="h-4 min-w-4 rounded-full bg-[var(--brand-solid)] px-0.5 text-center text-[10px] leading-[16px] text-[var(--brand-foreground)]">
                            {Object.keys(files).length}
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 py-2.5 pr-4 first:pl-3 aria-expanded:font-semibold sm:first:pl-4"
                        onClick={() =>
                          setMetaOpen((prev) =>
                            prev === "workspace" ? null : "workspace"
                          )
                        }
                        aria-expanded={metaOpen === "workspace"}
                      >
                        Workspace
                      </button>
                      <button
                        aria-label="Close"
                        className="flex-1"
                        onClick={() => setMetaOpen(null)}
                      />
                    </div>
                    <div
                      ref={tasksContainerRef}
                      className="px-3 sm:px-4"
                    >
                      {metaOpen === "tasks" &&
                        Object.entries(groupedTodos)
                          .filter(([_, todos]) => todos.length > 0)
                          .map(([status, todos]) => (
                            <div
                              key={status}
                              className="mb-4"
                            >
                              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
                                {
                                  {
                                    pending: "Pending",
                                    in_progress: "In Progress",
                                    completed: "Completed",
                                  }[status]
                                }
                              </h3>
                              <div className="grid grid-cols-[auto_1fr] gap-3 rounded-sm p-1 pl-0 text-sm">
                                {todos.map((todo, index) => (
                                  <Fragment
                                    key={`${status}_${todo.id}_${index}`}
                                  >
                                    {getStatusIcon(todo.status, "mt-0.5")}
                                    <span className="break-words text-inherit">
                                      {todo.content}
                                    </span>
                                  </Fragment>
                                ))}
                              </div>
                            </div>
                          ))}

                      {metaOpen === "files" && (
                        <div className="mb-6">
                          <FilesPopover
                            files={files}
                            setFiles={setFiles}
                            editDisabled={
                              isLoading === true || interrupt !== undefined
                            }
                          />
                        </div>
                      )}

                      {metaOpen === "workspace" && (
                        <div className="mb-6 pt-2">
                          <WorkspacePanel />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            }
            {autoApprove && (
              <div
                aria-live="polite"
                className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
              >
                <span className="flex items-center gap-1.5">
                  <TriangleAlert
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  Tool actions will run without review.
                </span>
                <button
                  type="button"
                  onClick={turnOffAutoApprove}
                  className="shrink-0 rounded px-2 py-1 font-semibold transition-colors hover:bg-amber-200 focus-visible:ring-2 focus-visible:ring-amber-700 dark:hover:bg-amber-900"
                >
                  Turn Off
                </button>
              </div>
            )}
            {(currentModel || runningAgents > 0) && (
              <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                {currentModel && (
                  <>
                    <Sparkles
                      className="size-3.5 shrink-0 text-[var(--brand)]"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-foreground">
                      {currentModel.name}
                    </span>
                    {currentModel.provider && (
                      <span>· {currentModel.provider}</span>
                    )}
                  </>
                )}
                {runningAgents > 0 && (
                  <button
                    type="button"
                    onClick={onShowAgents}
                    title={`${runningAgents} background agent${
                      runningAgents === 1 ? "" : "s"
                    } running — click to view`}
                    aria-label={`${runningAgents} background agent${
                      runningAgents === 1 ? "" : "s"
                    } running — view`}
                    className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-[var(--brand)] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className="size-2 animate-pulse rounded-full bg-[var(--color-warning)]"
                      aria-hidden="true"
                    />
                    {runningAgents} agent{runningAgents === 1 ? "" : "s"}
                  </button>
                )}
              </div>
            )}
            <form
              onSubmit={handleSubmit}
              className="flex flex-col"
            >
              {pendingFiles.length > 0 && (
                <div
                  aria-label="Attached files"
                  className="flex flex-wrap gap-2 border-b border-border px-3 py-2"
                >
                  {pendingFiles.map((file) => (
                    <span
                      key={file.path}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
                    >
                      <FileIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span
                        className="max-w-48 truncate"
                        title={file.path}
                      >
                        {file.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removePendingFile(file.path)}
                        aria-label={`Remove ${file.name} from this message`}
                        title={`Remove ${file.name} from this message`}
                        className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X
                          className="size-3.5"
                          aria-hidden="true"
                        />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label="Message"
                disabled={hasPendingInterrupt}
                placeholder={
                  hasPendingInterrupt
                    ? "Respond to the request above to continue…"
                    : isLoading
                    ? "Researching…"
                    : "Ask EvoScientist anything…"
                }
                className="font-inherit field-sizing-content flex-1 resize-none border-0 bg-transparent px-3.5 pb-2.5 pt-3 text-sm leading-6 text-primary outline-none placeholder:text-tertiary disabled:cursor-not-allowed sm:px-4"
                rows={1}
              />
              <div className="flex items-center justify-between gap-2 p-2 sm:p-2.5">
                <div className="flex items-center gap-1">
                  <input
                    ref={uploadInputRef}
                    type="file"
                    multiple
                    onChange={handleFilesSelected}
                    disabled={submitDisabled || isUploadingFiles}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={submitDisabled || isUploadingFiles}
                    aria-label="Upload files to workspace"
                    title="Upload files to workspace (max 50 MB each)"
                    className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Paperclip
                      className="size-4"
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      autoApprove
                        ? turnOffAutoApprove()
                        : setAutoApproveDialogOpen(true)
                    }
                    aria-pressed={autoApprove}
                    title="Auto-approve all tool actions in this conversation"
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                      autoApprove
                        ? "bg-amber-600 text-white hover:bg-amber-700"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <ShieldCheck
                      className="size-3.5"
                      aria-hidden="true"
                    />
                    <span className="hidden min-[360px]:inline">
                      {autoApprove ? "Auto-approve On" : "Auto-approve"}
                    </span>
                  </button>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type={isLoading ? "button" : "submit"}
                    variant={isLoading ? "destructive" : "default"}
                    onClick={isLoading ? stopStream : handleSubmit}
                    disabled={
                      !isLoading &&
                      (submitDisabled || isUploadingFiles || !input.trim())
                    }
                    aria-label={isLoading ? "Stop generating" : "Send message"}
                  >
                    {isLoading ? (
                      <>
                        <Square size={14} />
                        <span className="hidden sm:inline">Stop</span>
                      </>
                    ) : (
                      <>
                        <ArrowUp size={18} />
                        <span className="hidden sm:inline">Send</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }
);

ChatInterface.displayName = "ChatInterface";
