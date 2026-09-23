"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CircleCheckBigIcon,
  ChevronDown,
  Loader2,
  StopCircle,
  Zap,
} from "lucide-react";
import {
  aggregateWorkflows,
  dispatchElapsedMs,
  formatWorkflowTiming,
  sortWorkflowEvals,
  workflowCounts,
  workflowElapsedMs,
  ROW_ERROR_MAX_CHARS,
  type DispatchStatus,
  type WorkflowEval,
  type WorkflowMap,
} from "@/lib/dynamicWorkflow";
import { cn } from "@/lib/utils";

function DispatchStatusIcon({ status }: { status: DispatchStatus }) {
  if (status === "running") {
    return (
      <Loader2
        size={14}
        className="shrink-0 animate-spin"
        aria-label="running"
      />
    );
  }
  if (status === "done") {
    return (
      <CircleCheckBigIcon
        size={14}
        className="shrink-0 text-[var(--color-success)]"
        aria-label="done"
      />
    );
  }
  if (status === "cancelled") {
    return (
      <StopCircle
        size={14}
        className="shrink-0 text-muted-foreground"
        aria-label="cancelled"
      />
    );
  }
  return (
    <AlertCircle
      size={14}
      className="shrink-0 text-destructive"
      aria-label="error"
    />
  );
}

function PhaseStatusIcon({ evalData }: { evalData: WorkflowEval }) {
  const counts = workflowCounts(evalData);
  if (counts.running > 0) {
    return (
      <Loader2
        size={12}
        className="shrink-0 animate-spin"
        aria-label="running"
      />
    );
  }
  if (counts.failed > 0) {
    return (
      <AlertCircle
        size={12}
        className="shrink-0 text-destructive"
        aria-label="failed"
      />
    );
  }
  if (counts.cancelled > 0) {
    return (
      <StopCircle
        size={12}
        className="shrink-0 text-muted-foreground"
        aria-label="cancelled"
      />
    );
  }
  return (
    <CircleCheckBigIcon
      size={12}
      className="shrink-0 text-[var(--color-success)]"
      aria-label="all done"
    />
  );
}

function useWorkflowNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function DynamicWorkflowTrigger({
  workflows,
  expanded,
  onClick,
}: {
  workflows: WorkflowMap;
  expanded: boolean;
  onClick: () => void;
}) {
  const agg = useMemo(() => aggregateWorkflows(workflows), [workflows]);
  const now = useWorkflowNow(agg.running > 0);
  if (agg.phaseCount === 0) return null;
  const activeEval = agg.activeEvalId ? workflows[agg.activeEvalId] : undefined;
  const succeeded = agg.finished - agg.failed - agg.cancelled;
  const idleSummary = [
    `${succeeded} ✓`,
    agg.failed > 0 ? `${agg.failed} ✗` : null,
    agg.cancelled > 0 ? `${agg.cancelled} ⏹` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="grid w-full cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
    >
      {agg.running > 0 ? (
        <Loader2
          size={16}
          className="animate-spin"
        />
      ) : agg.failed > 0 ? (
        <AlertCircle
          size={16}
          className="text-destructive"
        />
      ) : (
        <Zap
          size={16}
          className="text-[var(--brand)]"
        />
      )}
      <span className="ml-[1px] min-w-0 truncate text-sm">
        {agg.running > 0
          ? `Workflow ${agg.finished}/${agg.total}`
          : `Dynamic workflow · ${agg.phaseCount} ${
              agg.phaseCount === 1 ? "phase" : "phases"
            }`}
      </span>
      <span className="min-w-0 truncate text-sm text-muted-foreground">
        {agg.running > 0 ? agg.runningLabel ?? "" : idleSummary}
      </span>
      {agg.running > 0 && activeEval ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatWorkflowTiming(workflowElapsedMs(activeEval, now))}
        </span>
      ) : (
        <span />
      )}
    </button>
  );
}

export function DynamicWorkflowPanel({
  workflows,
  expertNames,
}: {
  workflows: WorkflowMap;
  /** Installed expert names, from the deployment. Fan-out events carry no type
   *  flag, so matching the name is the only way to tell an expert dispatch
   *  apart from an ordinary sub-agent. Absent until the list loads — and an
   *  unmarked row simply reads as a plain sub-agent, never as an error. */
  expertNames?: ReadonlySet<string>;
}) {
  const phases = useMemo(() => sortWorkflowEvals(workflows), [workflows]);
  const agg = useMemo(() => aggregateWorkflows(workflows), [workflows]);
  const now = useWorkflowNow(agg.running > 0);
  const [selectedEvalId, setSelectedEvalId] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const displayed =
    (selectedEvalId
      ? phases.find((p) => p.evalId === selectedEvalId)
      : undefined) ??
    (agg.activeEvalId
      ? phases.find((p) => p.evalId === agg.activeEvalId)
      : undefined) ??
    phases[phases.length - 1];
  if (!displayed) return null;
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row">
      <div className="flex shrink-0 flex-row gap-1 overflow-x-auto sm:w-44 sm:flex-col sm:overflow-x-visible">
        {phases.map((phase, index) => {
          const counts = workflowCounts(phase);
          const isSelected = phase.evalId === displayed.evalId;
          return (
            <button
              key={phase.evalId}
              type="button"
              onClick={() => setSelectedEvalId(phase.evalId)}
              aria-pressed={isSelected}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring",
                isSelected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60"
              )}
            >
              <PhaseStatusIcon evalData={phase} />
              <span className="shrink-0">#{index + 1}</span>
              <span className="shrink-0 tabular-nums">
                {counts.finished}/{counts.total}
              </span>
              <span className="min-w-0 truncate font-mono text-[10px] tabular-nums">
                {formatWorkflowTiming(workflowElapsedMs(phase, now))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 flex-1">
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {displayed.dispatches.map((d) => {
            const hasDetail = !!d.error || d.description.length > 0;
            const rowOpen = !!expandedRows[d.id];
            const rowInner = (
              <>
                <DispatchStatusIcon status={d.status} />
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]",
                    expertNames?.has(d.subagentType)
                      ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                      : "bg-muted text-muted-foreground"
                  )}
                  title={
                    expertNames?.has(d.subagentType)
                      ? "Expert — dispatched with its own persona"
                      : undefined
                  }
                >
                  {d.subagentType}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-foreground"
                  title={d.label}
                >
                  {d.label}
                </span>
                {d.status === "error" && d.error && (
                  <span
                    className="min-w-0 max-w-[40%] truncate text-destructive"
                    title={d.error}
                  >
                    {d.error.slice(0, ROW_ERROR_MAX_CHARS)}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatWorkflowTiming(dispatchElapsedMs(d, now))}
                </span>
              </>
            );
            return (
              <div
                key={d.id}
                className="rounded-sm border border-border"
              >
                {hasDetail ? (
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedRows((prev) => ({
                        ...prev,
                        [d.id]: !prev[d.id],
                      }))
                    }
                    aria-expanded={rowOpen}
                    className="flex w-full items-center gap-2 bg-muted/30 p-2 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {rowInner}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        rowOpen && "rotate-180"
                      )}
                    />
                  </button>
                ) : (
                  <div className="flex w-full items-center gap-2 bg-muted/30 p-2 text-xs">
                    {rowInner}
                  </div>
                )}
                {rowOpen && hasDetail && (
                  <div className="space-y-1 border-t border-border bg-muted/20 p-2 text-xs">
                    {d.description && (
                      <p className="m-0 whitespace-pre-wrap break-words text-muted-foreground">
                        {d.description}
                      </p>
                    )}
                    {d.error && (
                      <p className="m-0 whitespace-pre-wrap break-all text-destructive">
                        {d.error}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
