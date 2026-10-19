"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useId,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Terminal,
  AlertCircle,
  CircleSlash,
  Loader2,
  CircleCheckBigIcon,
  StopCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolCall, ActionRequest, ReviewConfig } from "@/app/types/types";
import { cn } from "@/lib/utils";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";
import { formatToolLabel } from "@/lib/toolLabel";
import { stringifyUnknown } from "@/app/utils/utils";
import { autoApproveDecisions } from "@/lib/hitlPolicy";
import type { ActionRequest as HitlActionRequest } from "@/lib/hitl";
import {
  clipLine,
  fileEditDiff,
  foldRows,
  type DiffRow,
  type FileEditDiff,
  type ShownRow,
} from "@/lib/fileEditDiff";

// One-line preview of a tool-call argument value, shown next to the key in
// the collapsed args row. Strings have newlines collapsed; non-strings are
// JSON.stringify'd. Both truncated so the row stays one line.
function previewArgValue(value: unknown): string {
  const MAX = 80;
  const s = formatValue(value, { pretty: false }).replace(/\s+/g, " ").trim();
  return s.length > MAX ? s.slice(0, MAX - 1) + "…" : s;
}

function formatValue(value: unknown, options?: { pretty?: boolean }): string {
  return stringifyUnknown(value, options?.pretty ? 2 : 0);
}

function countLines(n: number, what: string): string {
  return `${n} ${n === 1 ? "line" : "lines"} ${what}`;
}

// "+2 −1" next to a file edit's name; read out as words.
function DiffCounts({
  added,
  removed,
  perMatch,
}: {
  added: number;
  removed: number;
  perMatch: boolean;
}) {
  const spoken = [
    added > 0 && countLines(added, "added"),
    removed > 0 && countLines(removed, "removed"),
  ].filter(Boolean);
  return (
    <span className="font-mono text-xs">
      <span
        aria-hidden="true"
        className="flex gap-1.5"
      >
        {added > 0 && (
          <span className="text-[var(--color-diff-added)]">+{added}</span>
        )}
        {removed > 0 && (
          <span className="text-[var(--color-diff-removed)]">−{removed}</span>
        )}
        {perMatch && (
          <span className="font-sans text-muted-foreground">per match</span>
        )}
      </span>
      <span className="sr-only">
        {spoken.join(", ") + (perMatch ? " per match" : "")}
      </span>
    </span>
  );
}

const SIGNS = { added: "+", removed: "−", context: " " } as const;
const SPOKEN = { added: "Added: ", removed: "Removed: " } as const;

function DiffLine({
  row,
  whole,
  onShowWhole,
}: {
  row: DiffRow;
  whole: boolean;
  onShowWhole: () => void;
}) {
  if (row.kind === "gap") {
    return (
      <li className="mb-0 select-none px-2 text-muted-foreground">
        <span aria-hidden="true">⋯</span>
        <span className="sr-only">Unchanged lines skipped</span>
      </li>
    );
  }
  if (row.kind === "note") {
    return (
      <li className="mb-0 select-none px-2 font-sans italic text-muted-foreground">
        {row.text}
      </li>
    );
  }
  const clipped = whole ? null : clipLine(row.text);
  return (
    <li
      className={cn(
        "mb-0 flex whitespace-pre-wrap px-2",
        row.kind === "added" && "bg-[var(--color-diff-added-bg)]",
        row.kind === "removed" && "bg-[var(--color-diff-removed-bg)]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-4 shrink-0 select-none",
          row.kind === "added" && "text-[var(--color-diff-added)]",
          row.kind === "removed" && "text-[var(--color-diff-removed)]"
        )}
      >
        {SIGNS[row.kind]}
      </span>
      <span className="min-w-0 flex-1 break-words">
        {row.kind !== "context" && (
          <span className="sr-only select-none">{SPOKEN[row.kind]}</span>
        )}
        {clipped ? clipped.head : row.text}
        {clipped && (
          <button
            type="button"
            onClick={onShowWhole}
            className="block select-none font-sans text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
          >
            Show {clipped.more.toLocaleString("en-US")} more characters
          </button>
        )}
      </span>
    </li>
  );
}

function FoldLine({
  hidden,
  onShowAll,
}: {
  hidden: number;
  onShowAll: () => void;
}) {
  return (
    <li className="mb-0 select-none">
      <button
        type="button"
        onClick={onShowAll}
        className="w-full px-2 py-0.5 pl-6 text-left font-sans text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11"
      >
        Show {hidden} more {hidden === 1 ? "line" : "lines"}
      </button>
    </li>
  );
}

interface ToolCallBoxProps {
  toolCall: ToolCall;
  uiComponent?: any;
  stream?: any;
  graphId?: string;
  actionRequest?: ActionRequest;
  actionRequestKey?: string;
  actionRequestSubmitted?: boolean;
  onActionRequestSubmitted?: (key: string) => void;
  reviewConfig?: ReviewConfig;
  onResume?: (value: any) => void;
  isLoading?: boolean;
  autoApprove?: boolean;
  /** Verdict for the whole pending interrupt, resolved by ChatInterface from
   *  the deployment's policy and this thread's auto-approve: true while it is
   *  being checked or will resume without the user. Omitted → decide locally
   *  from `autoApprove`. */
  approvalAutoResolves?: boolean;
  compact?: boolean;
}

export const ToolCallBox = React.memo<ToolCallBoxProps>(
  ({
    toolCall,
    uiComponent,
    stream,
    graphId,
    actionRequest,
    actionRequestKey: externalActionRequestKey,
    actionRequestSubmitted,
    onActionRequestSubmitted,
    reviewConfig,
    onResume,
    isLoading,
    autoApprove,
    approvalAutoResolves,
    compact = false,
  }) => {
    const policyWillPrompt =
      !!actionRequest &&
      autoApproveDecisions([actionRequest as HitlActionRequest]) === null;
    const needsPrompt =
      !!actionRequest &&
      !(approvalAutoResolves ?? (!!autoApprove && !policyWillPrompt));
    const [isExpanded, setIsExpanded] = useState(
      () => !!uiComponent || needsPrompt
    );
    const [expandedArgs, setExpandedArgs] = useState<Record<string, boolean>>(
      {}
    );
    const fallbackActionRequestKey = useMemo(() => {
      if (!actionRequest) return null;
      return `${toolCall.id}:${actionRequest.name}:${formatValue(
        actionRequest.args,
        { pretty: false }
      )}`;
    }, [actionRequest, toolCall.id]);
    const actionRequestKey =
      externalActionRequestKey ?? fallbackActionRequestKey;
    const [submittedActionRequestKey, setSubmittedActionRequestKey] = useState<
      string | null
    >(null);

    useEffect(() => {
      if (!actionRequestKey) {
        setSubmittedActionRequestKey(null);
        return;
      }
      setSubmittedActionRequestKey((current) =>
        current && current !== actionRequestKey ? null : current
      );
    }, [actionRequestKey]);

    // Generative UI: expand to show it.
    useEffect(() => {
      if (uiComponent) setIsExpanded(true);
    }, [uiComponent]);

    // Approval lifecycle: expand when an approval starts needing the user, and
    // collapse again once it's resolved. "Needing the user" can begin after the
    // request is already on screen — the deployment's policy is asked first and
    // may hand the decision back — so this watches `needsPrompt`, not just the
    // request's arrival.
    const prevActionRequestRef = useRef(actionRequest);
    const prevNeedsPromptRef = useRef(needsPrompt);
    useEffect(() => {
      const had = !!prevActionRequestRef.current;
      const has = !!actionRequest;
      if (needsPrompt && !prevNeedsPromptRef.current) setIsExpanded(true);
      else if (!has && had) setIsExpanded(false);
      prevActionRequestRef.current = actionRequest;
      prevNeedsPromptRef.current = needsPrompt;
    }, [actionRequest, needsPrompt]);

    const { name, args, result, status } = useMemo(() => {
      // Streaming can deliver args as a (possibly partial) JSON string, not an
      // object — treat it as `unknown` and only expose a real object to the
      // args view, so Object.keys/entries never run on a string.
      const rawArgs: unknown = toolCall.args;
      return {
        // Targeted label overrides only (read_file/write_file/edit_file on
        // /memories → "Reading memory"/"Updating memory", think_tool →
        // "Reflection"); every other tool keeps its raw name.
        name: formatToolLabel(toolCall.name, rawArgs),
        args:
          rawArgs && typeof rawArgs === "object"
            ? (rawArgs as Record<string, unknown>)
            : {},
        result: toolCall.result,
        status: toolCall.status || "completed",
      };
    }, [toolCall]);

    // edit_file / write_file show their change as a line diff once the call
    // has its result: while it streams, its args grow with every token, and a
    // call stopped before its result may have changed nothing. Keyed on the
    // text, as the tool call object is rebuilt on every render.
    const done = status === "completed";
    const { old_string: oldText, new_string: newText, content } = args;
    const diff = useMemo(
      () =>
        done
          ? fileEditDiff(toolCall.name, {
              old_string: oldText,
              new_string: newText,
              content,
            })
          : null,
      [done, toolCall.name, oldText, newText, content]
    );
    const perMatch = toolCall.name === "edit_file" && args.replace_all === true;
    // What the reader opened, for this diff only: the same call shown with
    // other args (a sub-agent's restored steps replaced by live ones) starts
    // folded again.
    const [opened, setOpened] = useState<{
      diff: FileEditDiff;
      all: boolean;
      lines: ReadonlySet<number>;
    } | null>(null);
    const openedHere = opened && opened.diff === diff ? opened : null;
    const diffListRef = useRef<HTMLUListElement>(null);
    const diffHeadingId = useId();
    const reveal = useCallback(
      (change: { all: true } | { line: number }) => {
        if (!diff) return;
        setOpened((prev) => {
          const here = prev?.diff === diff ? prev : null;
          const lines = new Set(here?.lines);
          if ("line" in change) lines.add(change.line);
          return { diff, all: "all" in change || !!here?.all, lines };
        });
        // The "Show more" button goes away; keep focus in the diff.
        diffListRef.current?.focus({ preventScroll: true });
      },
      [diff]
    );
    // Built once per change, not on each streamed token.
    const diffItems = useMemo(() => {
      if (!diff) return null;
      const shown: ShownRow[] = openedHere?.all
        ? diff.rows.map((row, key) => ({ key, row }))
        : foldRows(diff.rows);
      return shown.map((item) =>
        item.key === "fold" ? (
          <FoldLine
            key="fold"
            hidden={item.hidden}
            onShowAll={() => reveal({ all: true })}
          />
        ) : (
          <DiffLine
            key={item.key}
            row={item.row}
            whole={!!openedHere?.lines.has(item.key)}
            onShowWhole={() => reveal({ line: item.key })}
          />
        )
      );
    }, [diff, openedHere, reveal]);
    const argEntries = Object.entries(args).filter(
      ([key]) => !diff?.replaces.includes(key)
    );

    const statusIcon = useMemo(() => {
      switch (status) {
        case "completed":
          return <CircleCheckBigIcon />;
        case "error":
          return (
            <AlertCircle
              size={14}
              className="text-destructive"
              aria-label="Failed"
            />
          );
        case "pending":
          return (
            <Loader2
              size={14}
              className="animate-spin"
            />
          );
        case "interrupted":
          return (
            <StopCircle
              size={14}
              className="text-orange-500"
            />
          );
        case "stopped":
          return (
            <CircleSlash
              size={14}
              className="text-muted-foreground"
              aria-label="Did not finish"
            />
          );
        default:
          return (
            <Terminal
              size={14}
              className="text-muted-foreground"
            />
          );
      }
    }, [status]);

    const toggleExpanded = useCallback(() => {
      setIsExpanded((prev) => !prev);
    }, []);

    const toggleArgExpanded = useCallback((argKey: string) => {
      setExpandedArgs((prev) => ({
        ...prev,
        [argKey]: !prev[argKey],
      }));
    }, []);

    const hasResult = result !== undefined && result !== null;
    const hasContent = hasResult || Object.keys(args).length > 0;
    const isActionRequestSubmitted =
      actionRequestSubmitted ?? submittedActionRequestKey === actionRequestKey;
    const showApproval =
      actionRequest &&
      onResume &&
      (!actionRequestKey || !isActionRequestSubmitted);

    return (
      <div
        className={cn(
          "w-full overflow-hidden rounded-lg border-none shadow-none outline-none transition-colors duration-200 focus-within:ring-2 focus-within:ring-ring hover:bg-accent",
          compact && "rounded-md",
          isExpanded && hasContent && "bg-accent"
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleExpanded}
          className={cn(
            "flex w-full items-center justify-between gap-2 border-none px-2 py-2 text-left shadow-none outline-none disabled:cursor-default",
            compact && "h-auto min-h-8 py-1.5"
          )}
          disabled={!hasContent}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {statusIcon}
              <span
                className={cn(
                  "text-[15px] font-medium tracking-[-0.6px] text-foreground",
                  compact && "text-xs tracking-normal"
                )}
              >
                {name}
              </span>
              {diff && (diff.added > 0 || diff.removed > 0) && (
                <DiffCounts
                  added={diff.added}
                  removed={diff.removed}
                  perMatch={perMatch}
                />
              )}
            </div>
            {hasContent &&
              (isExpanded ? (
                <ChevronUp
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <ChevronDown
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              ))}
          </div>
        </Button>

        {isExpanded && hasContent && (
          <div className={cn("px-4 pb-4", compact && "px-2 pb-2")}>
            {uiComponent && stream && graphId ? (
              <div className="mt-4">
                <LoadExternalComponent
                  key={uiComponent.id}
                  stream={stream}
                  message={uiComponent}
                  namespace={graphId}
                  meta={{ status, args, result: result ?? "No Result Yet" }}
                />
              </div>
            ) : showApproval ? (
              // Show tool approval UI when there's an action request but no GenUI
              <div className="mt-4">
                <ToolApprovalInterrupt
                  actionRequest={actionRequest}
                  reviewConfig={reviewConfig}
                  onResume={onResume}
                  isLoading={isLoading}
                  onSubmitted={() => {
                    setSubmittedActionRequestKey(actionRequestKey);
                    if (actionRequestKey) {
                      onActionRequestSubmitted?.(actionRequestKey);
                    }
                    setIsExpanded(false);
                  }}
                />
              </div>
            ) : (
              <>
                {argEntries.length > 0 && (
                  <div className={cn("mt-4", compact && "mt-2")}>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Arguments
                    </h4>
                    <div className="space-y-2">
                      {argEntries.map(([key, value]) => {
                        const preview = previewArgValue(value);
                        const fullText = formatValue(value, { pretty: true });
                        // No fold when the preview already shows the value
                        // verbatim — saves a click on short single-line args.
                        const isFoldable = preview !== fullText;
                        const isOpen = isFoldable && !!expandedArgs[key];
                        const rowInner = (
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="shrink-0 font-mono">{key}:</span>
                            <span className="truncate font-mono font-normal text-muted-foreground">
                              {preview}
                            </span>
                          </span>
                        );
                        return (
                          <div
                            key={key}
                            className="rounded-sm border border-border"
                          >
                            {isFoldable ? (
                              <button
                                type="button"
                                onClick={() => toggleArgExpanded(key)}
                                className="flex w-full items-center justify-between gap-2 bg-muted/30 p-2 text-left text-xs font-medium transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              >
                                {rowInner}
                                {isOpen ? (
                                  <ChevronUp
                                    size={12}
                                    className="shrink-0 text-muted-foreground"
                                  />
                                ) : (
                                  <ChevronDown
                                    size={12}
                                    className="shrink-0 text-muted-foreground"
                                  />
                                )}
                              </button>
                            ) : (
                              <div className="flex items-center gap-2 bg-muted/30 p-2 text-xs font-medium">
                                {rowInner}
                              </div>
                            )}
                            {isOpen && (
                              <div
                                className={cn(
                                  "border-t border-border bg-muted/20 p-2",
                                  compact && "p-1.5"
                                )}
                              >
                                <pre
                                  className={cn(
                                    "m-0 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-6 text-foreground",
                                    compact && "text-[11px] leading-5"
                                  )}
                                >
                                  {fullText}
                                </pre>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {diff && (
                  <div className={cn("mt-4", compact && "mt-2")}>
                    <h4
                      id={diffHeadingId}
                      className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      Changes
                    </h4>
                    {/* role: Safari drops the list role of a list without
                        bullets, and with it the name. */}
                    <ul
                      ref={diffListRef}
                      role="list"
                      tabIndex={-1}
                      aria-labelledby={diffHeadingId}
                      className={cn(
                        "m-0 overflow-hidden rounded-sm border border-border bg-[var(--color-surface)] px-0 py-1 font-mono text-xs leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        compact && "py-0.5 text-[11px] leading-5"
                      )}
                    >
                      {diffItems}
                    </ul>
                  </div>
                )}
                {hasResult && (
                  <div className={cn("mt-4", compact && "mt-2")}>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Result
                    </h4>
                    <pre
                      className={cn(
                        "m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-xs leading-7 text-foreground",
                        compact && "p-1.5 text-[11px] leading-5"
                      )}
                    >
                      {formatValue(result, { pretty: true })}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);

ToolCallBox.displayName = "ToolCallBox";
