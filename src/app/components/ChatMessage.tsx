"use client";

import React, { useMemo, useState, useCallback } from "react";
import { SubAgentIndicator } from "@/app/components/SubAgentIndicator";
import { ToolCallBox } from "@/app/components/ToolCallBox";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import type {
  SubAgent,
  ToolCall,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Message } from "@langchain/langgraph-sdk";
import type { SubAgentStep } from "@/lib/subAgentActivity";
import { Brain, Check, ChevronRight, Copy, Pencil } from "lucide-react";
import {
  extractSubAgentContent,
  extractStringFromMessageContent,
} from "@/app/utils/utils";
import { cn } from "@/lib/utils";

interface ChatMessageProps {
  message: Message;
  toolCalls: ToolCall[];
  isLoading?: boolean;
  actionRequestsMap?: Map<string, ActionRequest>;
  reviewConfigsMap?: Map<string, ReviewConfig>;
  ui?: any[];
  stream?: any;
  onResumeInterrupt?: (value: any) => void;
  graphId?: string;
  onEditMessage?: (content: string) => void;
  autoApprove?: boolean;
  /** Live intermediate steps per task tool-call id (sub-agent activity). */
  subAgentSteps?: Record<string, SubAgentStep[]>;
}

/** A sub-agent's live steps: clickable tool-call boxes (each paired with its
 *  result) interleaved with the sub-agent's own text, reusing the same
 *  ToolCallBox the main agent uses. */
function SubAgentSteps({
  steps,
  hideFinalText,
}: {
  steps: SubAgentStep[];
  hideFinalText?: boolean;
}) {
  const resultByCallId = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === "tool_result" && s.toolCallId) {
      resultByCallId.set(s.toolCallId, s.text);
    }
  }
  // The sub-agent's final text is shown below as the task Output; once the task
  // is complete, drop that trailing text step here so it isn't duplicated.
  let lastTextIdx = -1;
  if (hideFinalText) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === "text") {
        lastTextIdx = i;
        break;
      }
    }
  }
  return (
    <div className="flex flex-col gap-1">
      {steps.map((s, i) => {
        if (i === lastTextIdx) return null;
        if (s.kind === "tool_call") {
          const toolCall: ToolCall = {
            id: s.id,
            name: s.name,
            args: s.args,
            result: resultByCallId.get(s.id),
            status: resultByCallId.has(s.id) ? "completed" : "pending",
          };
          return (
            <ToolCallBox
              key={s.id || `tc-${i}`}
              toolCall={toolCall}
            />
          );
        }
        if (s.kind === "text") {
          return (
            <div
              key={`txt-${i}`}
              className="px-2 text-sm"
            >
              <MarkdownContent content={s.text} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export const ChatMessage = React.memo<ChatMessageProps>(
  ({
    message,
    toolCalls,
    isLoading,
    actionRequestsMap,
    reviewConfigsMap,
    ui,
    stream,
    onResumeInterrupt,
    graphId,
    onEditMessage,
    autoApprove,
    subAgentSteps,
  }) => {
    const isUser = message.type === "human";
    const messageContent = extractStringFromMessageContent(message);
    const hasContent = messageContent && messageContent.trim() !== "";
    const hasToolCalls = toolCalls.length > 0;
    // Extended-thinking / reasoning text (Anthropic & friends store it here).
    const reasoning = useMemo(() => {
      const r = (
        message.additional_kwargs as Record<string, unknown> | undefined
      )?.reasoning_content;
      return typeof r === "string" && r.trim() ? r.trim() : null;
    }, [message.additional_kwargs]);
    const subAgents = useMemo(() => {
      return toolCalls
        .filter((toolCall: ToolCall) => {
          return (
            toolCall.name === "task" &&
            toolCall.args["subagent_type"] &&
            toolCall.args["subagent_type"] !== "" &&
            toolCall.args["subagent_type"] !== null
          );
        })
        .map((toolCall: ToolCall) => {
          const subagentType = (toolCall.args as Record<string, unknown>)[
            "subagent_type"
          ] as string;
          return {
            id: toolCall.id,
            name: toolCall.name,
            subAgentName: subagentType,
            input: toolCall.args,
            output: toolCall.result ? { result: toolCall.result } : undefined,
            status: toolCall.status,
          } as SubAgent;
        });
    }, [toolCalls]);

    const [thinkingOpen, setThinkingOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
      if (!messageContent) return;
      navigator.clipboard?.writeText(messageContent).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }, [messageContent]);
    const [expandedSubAgents, setExpandedSubAgents] = useState<
      Record<string, boolean>
    >({});
    const isSubAgentExpanded = useCallback(
      // Collapsed by default — while running the pill shows a spinner; click to
      // expand and watch the sub-agent's steps.
      (id: string) => expandedSubAgents[id] ?? false,
      [expandedSubAgents]
    );
    const toggleSubAgent = useCallback((id: string) => {
      // Default is collapsed (?? false), so an untouched block must expand on the
      // FIRST click — toggle off the same default the renderer uses.
      setExpandedSubAgents((prev) => ({
        ...prev,
        [id]: !(prev[id] ?? false),
      }));
    }, []);

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
            isUser ? "max-w-[70%]" : "w-full"
          )}
        >
          {!isUser && reasoning && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setThinkingOpen((v) => !v)}
                aria-expanded={thinkingOpen}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 transition-transform",
                    thinkingOpen && "rotate-90"
                  )}
                  aria-hidden="true"
                />
                <Brain
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                />
                Thinking
              </button>
              {thinkingOpen && (
                <div className="mt-2 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
                  {reasoning}
                </div>
              )}
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
                  <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {messageContent}
                  </p>
                ) : hasContent ? (
                  <MarkdownContent content={messageContent} />
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
                className="inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
          {isUser && hasContent && (
            <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <button
                type="button"
                onClick={handleCopy}
                aria-label={copied ? "Copied" : "Copy message"}
                className="inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                className="inline-flex items-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                if (toolCall.name === "task") return null;
                const toolCallGenUiComponent = ui?.find(
                  (u) => u.metadata?.tool_call_id === toolCall.id
                );
                const actionRequest = actionRequestsMap?.get(toolCall.name);
                const reviewConfig = reviewConfigsMap?.get(toolCall.name);
                return (
                  <ToolCallBox
                    key={toolCall.id}
                    toolCall={toolCall}
                    uiComponent={toolCallGenUiComponent}
                    stream={stream}
                    graphId={graphId}
                    actionRequest={actionRequest}
                    reviewConfig={reviewConfig}
                    onResume={onResumeInterrupt}
                    isLoading={isLoading}
                    autoApprove={autoApprove}
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
                  <div className="flex items-end gap-2">
                    <div className="w-[calc(100%-100px)]">
                      <SubAgentIndicator
                        subAgent={subAgent}
                        onClick={() => toggleSubAgent(subAgent.id)}
                        isExpanded={isSubAgentExpanded(subAgent.id)}
                      />
                    </div>
                  </div>
                  {isSubAgentExpanded(subAgent.id) && (
                    <div className="w-full max-w-full">
                      <div className="bg-surface border-border-light rounded-md border p-4">
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
                                hideFinalText={!!subAgent.output}
                              />
                            </div>
                          </>
                        )}
                        {subAgent.output && (
                          <>
                            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                              Output
                            </h4>
                            <MarkdownContent
                              content={extractSubAgentContent(subAgent.output)}
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
