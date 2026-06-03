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

export const ChatInterface = React.memo<ChatInterfaceProps>(({ assistant }) => {
  const [metaOpen, setMetaOpen] = useState<
    "tasks" | "files" | "workspace" | null
  >(null);
  const tasksContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<UploadedWorkspaceFile[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoApproveDialogOpen, setAutoApproveDialogOpen] = useState(false);
  const autoApprovedRef = useRef<unknown>(null);
  const [threadId] = useQueryState("threadId");
  const previousThreadIdRef = useRef(threadId);
  const preserveAutoApproveForNewThreadRef = useRef(false);
  const { scrollRef, contentRef } = useStickToBottom();

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
  } = useChatContext();

  // The model behind the latest assistant reply (read from message metadata).
  // Token/context usage is intentionally NOT shown — the backend doesn't persist
  // usage_metadata, so it isn't reliably available here.
  const currentModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== "ai") continue;
      const rm = m.response_metadata as Record<string, unknown> | undefined;
      const info = formatModel(rm?.model_name ?? rm?.model, rm?.model_provider);
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
  const turnOffAutoApprove = useCallback(() => {
    setAutoApprove(false);
    setAutoApproveDialogOpen(false);
    autoApprovedRef.current = null;
  }, []);

  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current;
    if (previousThreadId === threadId) return;

    const preserveForNewThread =
      previousThreadId === null &&
      threadId !== null &&
      preserveAutoApproveForNewThreadRef.current;

    if (!preserveForNewThread) turnOffAutoApprove();

    setPendingFiles([]);
    preserveAutoApproveForNewThreadRef.current = false;
    previousThreadIdRef.current = threadId;
  }, [threadId, turnOffAutoApprove]);

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
      if (!threadId && autoApprove) {
        preserveAutoApproveForNewThreadRef.current = true;
      }
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
      autoApprove,
      input,
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
    if (!ir || !Array.isArray(actionRequests) || actionRequests.length === 0) {
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
    const visibleMessages = messages.filter((message: Message) => {
      const meta = stream.getMessagesMetadata(message)?.streamMetadata;
      const ns = meta?.["langgraph_checkpoint_ns"];
      return !(typeof ns === "string" && ns.includes("|"));
    });
    visibleMessages.forEach((message: Message) => {
      if (message.type === "ai") {
        const toolCallsInMessage: Array<{
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
          toolCallsInMessage.push(...message.additional_kwargs.tool_calls);
        } else if (message.tool_calls && Array.isArray(message.tool_calls)) {
          toolCallsInMessage.push(
            ...message.tool_calls.filter(
              (toolCall: { name?: string }) => toolCall.name !== ""
            )
          );
        } else if (Array.isArray(message.content)) {
          const toolUseBlocks = message.content.filter(
            (block: { type?: string }) => block.type === "tool_use"
          );
          toolCallsInMessage.push(...toolUseBlocks);
        }
        const toolCallsWithStatus = toolCallsInMessage.map(
          (toolCall: {
            id?: string;
            function?: { name?: string; arguments?: unknown };
            name?: string;
            type?: string;
            args?: unknown;
            input?: unknown;
          }) => {
            const name =
              toolCall.function?.name ||
              toolCall.name ||
              toolCall.type ||
              "unknown";
            const args =
              toolCall.function?.arguments ||
              toolCall.args ||
              toolCall.input ||
              {};
            return {
              id: toolCall.id || `tool-${Math.random()}`,
              name,
              args,
              status: interrupt ? "interrupted" : ("pending" as const),
            } as ToolCall;
          }
        );
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
      const prevMessage = index > 0 ? processedArray[index - 1].message : null;
      return {
        ...data,
        showAvatar: data.message.type !== prevMessage?.type,
      };
    });
  }, [messages, interrupt, stream]);

  const groupedTodos = {
    in_progress: todos.filter((t) => t.status === "in_progress"),
    pending: todos.filter((t) => t.status === "pending"),
    completed: todos.filter((t) => t.status === "completed"),
  };

  const hasTasks = todos.length > 0;
  const hasFiles = Object.keys(files).length > 0;

  // Parse out any action requests or review configs from the interrupt
  const actionRequestsMap: Map<string, ActionRequest> | null = useMemo(() => {
    const actionRequests =
      interrupt?.value && (interrupt.value as any)["action_requests"];
    if (!actionRequests) return new Map<string, ActionRequest>();
    return new Map(actionRequests.map((ar: ActionRequest) => [ar.name, ar]));
  }, [interrupt]);

  const reviewConfigsMap: Map<string, ReviewConfig> | null = useMemo(() => {
    const reviewConfigs =
      interrupt?.value && (interrupt.value as any)["review_configs"];
    if (!reviewConfigs) return new Map<string, ReviewConfig>();
    return new Map(
      reviewConfigs.map((rc: ReviewConfig) => [rc.actionName, rc])
    );
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
              EvoScientist will run tool actions in this research without asking
              you to review each one. Turn this on only when you trust the
              current task and deployment.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <p>
              Auto-approve turns off automatically when you switch research or
              start a new chat.
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
              onClick={() => {
                setAutoApprove(true);
                setAutoApproveDialogOpen(false);
              }}
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
          className="mx-auto w-full max-w-[1024px] px-6 pb-6 pt-4"
          ref={contentRef}
        >
          {isThreadLoading ? (
            <div className="flex items-center justify-center p-8">
              <p className="text-muted-foreground">Loading…</p>
            </div>
          ) : (
            <>
              {processedMessages.length === 0 && !isLoading && !threadId && (
                <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 text-center">
                  <h2 className="text-pretty text-xl font-semibold">
                    Start Research
                  </h2>
                  <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                    Ask EvoScientist to review literature, inspect workspace
                    files, or plan the next experiment.
                  </p>
                  <div className="mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => handleSuggestedPrompt(prompt)}
                        className="max-w-full rounded-full border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm transition-colors hover:border-[var(--color-border)] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
                    actionRequestsMap={
                      isLastMessage ? actionRequestsMap : undefined
                    }
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
            "mb-3 flex flex-shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background sm:mb-6",
            "mx-auto w-[calc(100%-24px)] max-w-[1024px] transition-colors duration-200 ease-in-out sm:w-[calc(100%-32px)]",
            "focus-within:ring-2 focus-within:ring-ring"
          )}
        >
          {/* Always rendered: the Workspace tab is available even with no tasks
              or state files yet. */}
          {
            <div className="flex max-h-72 flex-col overflow-y-auto border-b border-border bg-sidebar empty:hidden">
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
                          className="grid w-full cursor-pointer grid-cols-[auto_auto_1fr] items-center gap-3 px-[18px] py-3 text-left"
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
                                  {totalTasks - groupedTodos.pending.length} of{" "}
                                  {totalTasks}
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
                                Task {totalTasks - groupedTodos.pending.length}{" "}
                                of {totalTasks}
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
                          className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-[18px] py-3 text-left text-sm"
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
                        className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-3 py-3 text-left text-sm sm:px-[18px]"
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
                        className="py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
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
                        className="inline-flex items-center gap-2 py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
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
                      className="inline-flex items-center gap-2 py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
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
                    className="px-[18px]"
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
                                <Fragment key={`${status}_${todo.id}_${index}`}>
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
          {currentModel && (
            <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
              <Sparkles
                className="size-3.5 shrink-0 text-[var(--brand)]"
                aria-hidden="true"
              />
              <span className="font-medium text-foreground">
                {currentModel.name}
              </span>
              {currentModel.provider && <span>· {currentModel.provider}</span>}
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
              className="font-inherit field-sizing-content flex-1 resize-none border-0 bg-transparent px-4 pb-3 pt-[14px] text-sm leading-7 text-primary outline-none placeholder:text-tertiary disabled:cursor-not-allowed sm:px-[18px]"
              rows={1}
            />
            <div className="flex items-center justify-between gap-2 p-2.5 sm:p-3">
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
});

ChatInterface.displayName = "ChatInterface";
