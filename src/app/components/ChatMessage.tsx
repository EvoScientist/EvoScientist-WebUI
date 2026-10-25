"use client";

import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { SubAgentIndicator } from "@/app/components/SubAgentIndicator";
import { ToolCallBox } from "@/app/components/ToolCallBox";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { PinnedSkill } from "@/app/components/PinnedSkill";
import { RubricRevision } from "@/app/components/RubricRevision";
import { SubAgentSteps } from "@/app/components/SubAgentSteps";
import { ThinkingRow } from "@/app/components/ThinkingRow";
import type {
  SubAgent,
  ToolCall,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Message } from "@langchain/langgraph-sdk";
import { taskSubAgentName, type SubAgentStep } from "@/lib/subAgentActivity";
import { isAsyncUpdateMessage } from "@/lib/asyncAgents";
import { bindActionRequestsToToolCalls } from "@/lib/hitl";
import { pinnedSkillDescription, pinnedSkillName } from "@/lib/pinnedSkill";
import { pinnedLead } from "@/lib/composerChip";
import { ComposerChip } from "@/app/components/ComposerChip";
import { isRubricRevision } from "@/lib/rubricRevision";
import { messageReasoning } from "@/lib/reasoning";
import { thoughtLabel, useThoughtSeconds } from "@/lib/thinkingTimer";
import { AlertTriangle, Bell, Check, Copy, Pencil } from "lucide-react";
import {
  extractStringFromMessageContent,
  extractSubAgentContent,
  stringifyUnknown,
} from "@/app/utils/utils";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { toast } from "sonner";

interface ChatMessageProps {
  message: Message;
  toolCalls: ToolCall[];
  isLoading?: boolean;
  /** True only for the message currently being streamed (last assistant turn). */
  isStreaming?: boolean;
  /** Pending tool-approval requests for this turn, in interrupt order. */
  actionRequests?: ActionRequest[];
  submittedActionRequestKeys?: Set<string>;
  onActionRequestSubmitted?: (key: string) => void;
  reviewConfigsMap?: Map<string, ReviewConfig>;
  ui?: any[];
  stream?: any;
  onResumeInterrupt?: (value: any) => void;
  graphId?: string;
  onEditMessage?: (content: string) => void;
  autoApprove?: boolean;
  approvalAutoResolves?: boolean;
  subAgentSteps?: Record<string, SubAgentStep[]>;
  /** The skills the backend pinned for this user message (the markers
   *  after it): drawn as chips while they lead its text. */
  pinnedSkills?: readonly string[];
}

const NO_PINS: readonly string[] = [];

const FINISH_REASON_SUCCESS = new Set([
  "stop",
  "tool_calls",
  "function_call",
  "end_turn",
  "tool_use",
]);

// Two ways a successful turn can read as an abnormal one. Providers disagree on
// case — Gemini and Vertex send "STOP" / "MAX_TOKENS". And a duplicated terminal
// SSE chunk makes langchain's `merge_dicts` concatenate `finish_reason` with
// itself ("stopstop"), which the live backend still emits more often than the
// plain form. Fold both away before consulting the success set.
function normalizeFinishReason(raw: string): string {
  const lowered = raw.toLowerCase();
  for (const value of FINISH_REASON_SUCCESS) {
    if (lowered !== value && lowered.length % value.length === 0) {
      const repeatCount = lowered.length / value.length;
      if (repeatCount > 1 && value.repeat(repeatCount) === lowered)
        return value;
    }
  }
  return lowered;
}

// A `task` call shows as a sub-agent card once it names its sub-agent.
function showsAsSubAgent(toolCall: ToolCall): boolean {
  return toolCall.name === "task" && taskSubAgentName(toolCall.args) !== null;
}

/** A user message's text, its pinned skills drawn as chips ahead of it; a
 *  screen reader reads it as it was sent. */
function UserText({
  text,
  pinnedSkills,
}: {
  text: string;
  pinnedSkills: readonly string[];
}) {
  const { skills, rest } = pinnedLead(text, pinnedSkills);
  return (
    <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
      {skills.length > 0 && (
        <>
          <span className="sr-only">
            {text.slice(0, text.length - rest.length)}
          </span>
          {/* A selection copies the text as sent. */}
          <span
            aria-hidden="true"
            className="select-none"
          >
            {skills.map((name, i) => (
              <ComposerChip
                key={`${i}:${name}`}
                chip={{ kind: "skill", name }}
                className="mr-1.5 h-5 align-middle"
              />
            ))}
          </span>
        </>
      )}
      {rest}
    </p>
  );
}

export const ChatMessage = React.memo<ChatMessageProps>(
  ({
    message,
    toolCalls,
    isLoading,
    isStreaming,
    actionRequests,
    submittedActionRequestKeys,
    onActionRequestSubmitted,
    reviewConfigsMap,
    ui,
    stream,
    onResumeInterrupt,
    graphId,
    onEditMessage,
    autoApprove,
    approvalAutoResolves,
    subAgentSteps,
    pinnedSkills = NO_PINS,
  }) => {
    const isUser = message.type === "human";
    const messageContent = extractStringFromMessageContent(message);
    const hasContent = messageContent && messageContent.trim() !== "";
    const hasToolCalls = toolCalls.length > 0;
    const reasoning = useMemo(
      () =>
        messageReasoning({
          additional_kwargs: message.additional_kwargs,
          content: message.content,
        }),
      [message.additional_kwargs, message.content]
    );
    // An abnormal turn-end is otherwise invisible: the run finishes
    // server-side, the thread goes idle, and no interrupt is raised.
    const terminalError = useMemo(() => {
      if (isUser) return null;
      const raw = (
        message.response_metadata as Record<string, unknown> | undefined
      )?.finish_reason;
      if (typeof raw !== "string" || !raw) return null;
      if (FINISH_REASON_SUCCESS.has(normalizeFinishReason(raw))) return null;
      const variant =
        !hasContent && !hasToolCalls
          ? ("missing" as const)
          : ("partial" as const);
      // Show what the provider actually sent, not the folded form.
      return { finishReason: raw, variant };
    }, [isUser, hasContent, hasToolCalls, message.response_metadata]);
    const subAgents = useMemo(() => {
      return toolCalls.filter(showsAsSubAgent).map((toolCall: ToolCall) => {
        const subagentType = (toolCall.args as Record<string, unknown>)[
          "subagent_type"
        ] as string;
        const status: SubAgent["status"] =
          toolCall.status === "completed"
            ? "completed"
            : toolCall.status === "error"
            ? "error"
            : toolCall.status === "pending"
            ? "pending"
            : toolCall.status === "stopped"
            ? "stopped"
            : "active";
        return {
          id: toolCall.id,
          name: toolCall.name,
          subAgentName: subagentType,
          input: toolCall.args,
          output:
            toolCall.result !== undefined && toolCall.result !== null
              ? toolCall.result
              : undefined,
          status,
        } satisfies SubAgent;
      });
    }, [toolCalls]);

    const actionRequestByToolCallId = useMemo(
      () => bindActionRequestsToToolCalls(toolCalls, actionRequests ?? []),
      [actionRequests, toolCalls]
    );

    const actionRequestsKey = useMemo(() => {
      return stringifyUnknown(
        (actionRequests ?? []).map((ar) => ({
          name: ar.name,
          args: ar.args,
        })),
        0
      );
    }, [actionRequests]);
    const pendingReviewDecisionsRef = useRef<Record<number, unknown>>({});
    useEffect(() => {
      pendingReviewDecisionsRef.current = {};
    }, [actionRequestsKey]);

    const handleResumeActionRequest = useCallback(
      (actionIndex: number, value: any) => {
        const decisions = value?.decisions;
        if (!Array.isArray(decisions) || !actionRequests?.length) {
          onResumeInterrupt?.(value);
          return;
        }
        if (
          actionRequests.length === 1 ||
          decisions.length === actionRequests.length
        ) {
          onResumeInterrupt?.(value);
          return;
        }

        const decision = decisions[0];
        const next = {
          ...pendingReviewDecisionsRef.current,
          [actionIndex]: decision,
        };
        pendingReviewDecisionsRef.current = next;

        const allDecided = actionRequests.every((_, index) => next[index]);
        if (!allDecided) return;

        pendingReviewDecisionsRef.current = {};
        onResumeInterrupt?.({
          decisions: actionRequests.map((_, index) => next[index]),
        });
      },
      [actionRequests, onResumeInterrupt]
    );

    // Still thinking: the answer and the tool calls haven't started.
    const thinking =
      !!isStreaming && !!reasoning && !hasContent && !hasToolCalls;
    const thought = useThoughtSeconds(message.id);
    const [copied, setCopied] = useState(false);
    const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );
    useEffect(
      () => () => {
        if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      },
      []
    );
    useEffect(() => {
      setCopied(false);
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    }, [messageContent]);
    const handleCopy = useCallback(async () => {
      if (!messageContent) return;
      if (await copyText(messageContent)) {
        setCopied(true);
        if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
        copyResetTimer.current = setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error("Couldn't copy to clipboard.");
      }
    }, [messageContent]);
    const [expandedSubAgents, setExpandedSubAgents] = useState<
      Record<string, boolean>
    >({});
    const isSubAgentExpanded = useCallback(
      (id: string) => expandedSubAgents[id] ?? false,
      [expandedSubAgents]
    );
    const toggleSubAgent = useCallback((id: string) => {
      setExpandedSubAgents((prev) => ({
        ...prev,
        [id]: !(prev[id] ?? false),
      }));
    }, []);
    // A "[Async tasks update]" signal we injected (from the Agents board's
    // "Notify main chat") is a background-completion notice, not something the
    // user typed — render it as a low-key centered system pill, not a user
    // bubble. The main agent's response (check_async_task etc.) renders normally.
    if (isUser && isAsyncUpdateMessage(messageContent)) {
      return (
        <div className="flex w-full justify-center py-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
            <Bell
              className="size-3 text-[var(--brand)]"
              aria-hidden="true"
            />
            Background agent reported back
          </span>
        </div>
      );
    }

    // A pinned skill is context the backend appended for the model, not
    // something the user typed — show a collapsed row on the agent side, no
    // bubble or actions.
    const pinnedSkill = pinnedSkillName(message);
    if (pinnedSkill !== null) {
      return (
        <PinnedSkill
          name={pinnedSkill}
          description={pinnedSkillDescription(message)}
          content={messageContent}
        />
      );
    }
    // Likewise the rubric grader's request for revisions.
    if (isRubricRevision(message)) {
      return <RubricRevision content={messageContent} />;
    }

    return (
      <div
        className={cn(
          "group flex w-full max-w-full overflow-x-hidden",
          isUser && "flex-row-reverse"
        )}
      >
        <div
          className={cn(
            "min-w-0 max-w-full",
            isUser ? "max-w-[90%] sm:max-w-[70%]" : "w-full"
          )}
        >
          {!isUser && reasoning && (
            <ThinkingRow
              className="mt-4"
              reasoning={reasoning}
              thinking={thinking}
              label={thoughtLabel(thought)}
              isStreaming={isStreaming}
            />
          )}
          {terminalError && terminalError.variant === "missing" && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <span>
                This turn ended without a response (
                <span className="font-mono text-xs">
                  {terminalError.finishReason}
                </span>
                ). Re-send your last message to try again.
              </span>
            </div>
          )}
          {hasContent && (
            <div className={cn("relative flex items-end gap-0")}>
              <div
                className={cn(
                  "mt-4 overflow-hidden break-words text-sm font-normal leading-[150%]",
                  isUser
                    ? "rounded-xl rounded-br-none border border-border px-3 py-2 text-foreground"
                    : "text-primary"
                )}
                style={
                  isUser
                    ? { backgroundColor: "var(--color-user-message-bg)" }
                    : undefined
                }
              >
                {isUser ? (
                  <UserText
                    text={messageContent}
                    pinnedSkills={pinnedSkills}
                  />
                ) : hasContent ? (
                  <MarkdownContent
                    content={messageContent}
                    isStreaming={isStreaming}
                  />
                ) : null}
              </div>
            </div>
          )}
          {!isUser && hasContent && (
            <div className="mt-1">
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? "Copied" : "Copy message"}
                className="inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? (
                  <Check
                    className="h-4 w-4"
                    aria-hidden="true"
                  />
                ) : (
                  <Copy
                    className="h-4 w-4"
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          )}
          {terminalError && terminalError.variant === "partial" && (
            <div className="border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm text-foreground">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]"
                aria-hidden="true"
              />
              <span>
                Agent ended its turn unexpectedly (
                <span className="font-mono text-xs">
                  {terminalError.finishReason}
                </span>
                ). The response above may be incomplete.
              </span>
            </div>
          )}
          {isUser && hasContent && (
            <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? "Copied" : "Copy message"}
                className="inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? (
                  <Check
                    className="h-4 w-4"
                    aria-hidden="true"
                  />
                ) : (
                  <Copy
                    className="h-4 w-4"
                    aria-hidden="true"
                  />
                )}
              </button>
              <button
                type="button"
                onClick={() => onEditMessage?.(messageContent)}
                aria-label="Edit message"
                className="inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Pencil
                  className="h-4 w-4"
                  aria-hidden="true"
                />
              </button>
            </div>
          )}
          {hasToolCalls && (
            <div className="mt-4 flex w-full flex-col">
              {toolCalls.map((toolCall: ToolCall) => {
                // A task that settled without naming its sub-agent (it failed
                // validation) shows as a row; while it streams, neither.
                if (
                  toolCall.name === "task" &&
                  (showsAsSubAgent(toolCall) || toolCall.status === "pending")
                )
                  return null;
                const toolCallGenUiComponent = ui?.find(
                  (u) => u.metadata?.tool_call_id === toolCall.id
                );
                const actionRequestEntry = actionRequestByToolCallId.get(
                  toolCall.id
                );
                const actionRequest = actionRequestEntry?.actionRequest;
                // Key the "already submitted" dedup by the tool-call id, which is
                // unique per occurrence. Keying by name+args (as before) made two
                // identical interrupts (e.g. two `execute pwd` in a row) collide,
                // permanently hiding the second approval card.
                const actionRequestKey = actionRequestEntry
                  ? toolCall.id
                  : undefined;
                const reviewConfig = reviewConfigsMap?.get(toolCall.name);
                return (
                  <ToolCallBox
                    key={toolCall.id}
                    toolCall={toolCall}
                    uiComponent={toolCallGenUiComponent}
                    stream={stream}
                    graphId={graphId}
                    actionRequest={actionRequest}
                    actionRequestKey={actionRequestKey}
                    actionRequestSubmitted={
                      actionRequestKey
                        ? submittedActionRequestKeys?.has(actionRequestKey)
                        : undefined
                    }
                    onActionRequestSubmitted={onActionRequestSubmitted}
                    reviewConfig={reviewConfig}
                    onResume={
                      actionRequestEntry
                        ? (value) =>
                            handleResumeActionRequest(
                              actionRequestEntry.actionIndex,
                              value
                            )
                        : onResumeInterrupt
                    }
                    isLoading={isLoading}
                    autoApprove={autoApprove}
                    approvalAutoResolves={approvalAutoResolves}
                  />
                );
              })}
            </div>
          )}
          {!isUser && subAgents.length > 0 && (
            <div className="flex w-fit max-w-full flex-col gap-4">
              {subAgents.map((subAgent) => (
                <div
                  key={subAgent.id}
                  className="flex w-full flex-col gap-2"
                >
                  <SubAgentIndicator
                    subAgent={subAgent}
                    onToggle={toggleSubAgent}
                    isExpanded={isSubAgentExpanded(subAgent.id)}
                  />
                  {isSubAgentExpanded(subAgent.id) && (
                    <div className="w-full max-w-full">
                      <div className="border-border-light rounded-md border bg-[var(--color-surface)] p-4">
                        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                          Input
                        </h4>
                        <div className="mb-4">
                          <MarkdownContent
                            content={extractSubAgentContent(subAgent.input)}
                          />
                        </div>
                        {(subAgentSteps?.[subAgent.id]?.length ?? 0) > 0 && (
                          <>
                            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                              Steps
                            </h4>
                            <div className="mb-4">
                              <SubAgentSteps
                                steps={subAgentSteps![subAgent.id]}
                                running={
                                  subAgent.status === "pending" ||
                                  subAgent.status === "active"
                                }
                                // A failed task's output is the error, not
                                // the sub-agent's last text.
                                hideFinalText={
                                  subAgent.status === "completed" &&
                                  subAgent.output !== undefined &&
                                  subAgent.output !== null
                                }
                              />
                            </div>
                          </>
                        )}
                        {subAgent.output !== undefined &&
                          subAgent.output !== null && (
                            <>
                              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                                Output
                              </h4>
                              <MarkdownContent
                                content={extractSubAgentContent(
                                  subAgent.output
                                )}
                              />
                            </>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
);

ChatMessage.displayName = "ChatMessage";
