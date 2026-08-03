"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronUp, Loader2 } from "lucide-react";
import { ToolCallBox } from "@/app/components/ToolCallBox";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import type { ToolCall } from "@/app/types/types";
import type { FoldGroup, SubAgentStep } from "@/lib/subAgentActivity";
import { groupStepsForFold } from "@/lib/subAgentActivity";
import { useCollapseAgentActions } from "@/lib/uiSettings";
import { cn } from "@/lib/utils";

/** Render a sub-agent's steps as a vertical timeline of tool-call boxes (args +
 *  result + status) interleaved with the sub-agent's own text, reusing the SAME
 *  ToolCallBox + MarkdownContent the main agent uses. Used by the inline
 *  sub-agent block (ChatMessage) and by the persona focus view (Pass 3).
 *
 *  Opt-in `foldable`: groups consecutive tool activity between text boundaries
 *  into a collapsible block, mirroring `<ActionGroup>` in the main chat. When
 *  the last group's run is still in progress (`isStreaming`), it stays open and
 *  auto-collapses on settle — subject to the user's `useCollapseAgentActions`
 *  preference and a manual-toggle-wins guard. */
export function SubAgentSteps({
  steps,
  hideFinalText,
  compact = false,
  foldable = false,
  isStreaming = false,
}: {
  steps: SubAgentStep[];
  hideFinalText?: boolean;
  compact?: boolean;
  /** Group tool-only runs into a foldable block (like the main chat). */
  foldable?: boolean;
  /** True when the sub-thread's own run is still active — the LAST action
   *  group renders as streaming and auto-collapse fires on transition. Ignored
   *  when `foldable` is false. */
  isStreaming?: boolean;
}) {
  const resultByCallId = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of steps) {
      if (s.kind === "tool_result" && s.toolCallId) {
        m.set(s.toolCallId, s.text);
      }
    }
    return m;
  }, [steps]);

  // The sub-agent's final text is sometimes shown separately as the task Output;
  // when asked, drop that trailing text step here so it isn't duplicated.
  const lastTextIdx = useMemo(() => {
    if (!hideFinalText) return -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === "text") return i;
    }
    return -1;
  }, [steps, hideFinalText]);

  if (foldable) {
    const groups = groupStepsForFold(steps, lastTextIdx);
    const lastActionIdx = lastActionsIndex(groups);
    return (
      <div className={cn("flex flex-col gap-1", compact && "gap-0.5")}>
        {groups.map((g, idx) => {
          if (g.kind === "text") {
            return (
              <TextStep
                key={`txt-${g.originalIndex}`}
                text={g.step.text}
                compact={compact}
              />
            );
          }
          return (
            <FoldableActionRun
              key={`grp-${g.startIndex}-${
                g.steps[0].kind === "tool_call" ? g.steps[0].id : "x"
              }`}
              steps={g.steps}
              resultByCallId={resultByCallId}
              compact={compact}
              isStreaming={isStreaming && idx === lastActionIdx}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", compact && "gap-0.5")}>
      {steps.map((s, i) => {
        if (i === lastTextIdx) return null;
        if (s.kind === "tool_call") {
          return (
            <ToolCallBox
              key={s.id || `tc-${i}`}
              toolCall={buildToolCall(s, resultByCallId)}
              compact={compact}
            />
          );
        }
        if (s.kind === "text") {
          return (
            <TextStep
              key={`txt-${i}`}
              text={s.text}
              compact={compact}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function buildToolCall(
  s: Extract<SubAgentStep, { kind: "tool_call" }>,
  resultByCallId: Map<string, string>
): ToolCall {
  return {
    id: s.id,
    name: s.name,
    args: s.args,
    result: resultByCallId.get(s.id),
    status: resultByCallId.has(s.id) ? "completed" : "pending",
  };
}

function TextStep({ text, compact }: { text: string; compact: boolean }) {
  return (
    <div className={cn("px-2 text-sm", compact && "px-1 text-xs")}>
      <MarkdownContent
        content={text}
        className={
          compact
            ? "text-xs leading-5 [&_blockquote]:my-2 [&_blockquote]:pl-2 [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-base [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h4]:mb-1.5 [&_h4]:mt-3 [&_h4]:text-sm [&_ol]:my-2 [&_ol]:pl-5 [&_p]:mb-2 [&_table]:text-[11px] [&_td]:p-1.5 [&_th]:p-1.5 [&_ul]:my-2 [&_ul]:pl-5"
            : undefined
        }
      />
    </div>
  );
}

/** One collapsible run: header (chevron + count + last tool name), body of
 *  ToolCallBox rows. Same visual grammar as ActionGroup so users see one
 *  fold pattern across the whole product. */
function FoldableActionRun({
  steps,
  resultByCallId,
  compact,
  isStreaming,
}: {
  steps: SubAgentStep[];
  resultByCallId: Map<string, string>;
  compact: boolean;
  isStreaming: boolean;
}) {
  const { value: defaultCollapsed } = useCollapseAgentActions();
  const [open, setOpen] = useState<boolean>(() => !defaultCollapsed);
  const wasStreamingRef = useRef(isStreaming);
  const userTouchedRef = useRef(false);

  const handleToggle = () => {
    userTouchedRef.current = true;
    setOpen((v) => !v);
  };
  const handleCollapse = () => {
    userTouchedRef.current = true;
    setOpen(false);
  };

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (userTouchedRef.current) return;
    if (wasStreaming && !isStreaming && defaultCollapsed) {
      setOpen(false);
    }
  }, [isStreaming, defaultCollapsed]);

  const toolCalls = steps.filter(
    (s): s is Extract<SubAgentStep, { kind: "tool_call" }> =>
      s.kind === "tool_call"
  );
  const count = toolCalls.length;
  const lastToolName =
    toolCalls.length > 0 ? toolCalls[toolCalls.length - 1].name : "action";
  const headerText = isStreaming
    ? `${count} action${count === 1 ? "" : "s"} running — ${lastToolName}`
    : `${count} action${count === 1 ? "" : "s"} — last: ${lastToolName}`;

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${headerText}`}
        title={headerText}
        onClick={handleToggle}
        className="group flex w-full items-center gap-2 rounded-md border border-border bg-[var(--color-surface)] px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        {isStreaming && (
          <Loader2
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin text-[var(--brand)]"
          />
        )}
        <span className="truncate">{headerText}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l-2 border-border pl-3">
          {steps.map((s, i) => {
            if (s.kind !== "tool_call") return null;
            return (
              <ToolCallBox
                key={s.id || `tc-${i}`}
                toolCall={buildToolCall(s, resultByCallId)}
                compact={compact}
              />
            );
          })}
          <button
            type="button"
            onClick={handleCollapse}
            className="flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Collapse ${count} action${count === 1 ? "" : "s"}`}
          >
            <ChevronUp
              aria-hidden="true"
              className="size-3.5"
            />
            Collapse
          </button>
        </div>
      )}
    </div>
  );
}

function lastActionsIndex(groups: FoldGroup[]): number {
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].kind === "actions") return i;
  }
  return -1;
}
