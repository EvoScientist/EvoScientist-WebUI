"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { makeClient, type ScheduledTask } from "@/app/hooks/useScheduledTasks";
import { useScheduledTaskRuns } from "@/app/hooks/useScheduledTaskRuns";
import { isActiveStatus, type ScheduledRunRecord } from "@/lib/scheduledRuns";
import { formatElapsed } from "@/lib/asyncAgents";
import { nextRunLabel } from "@/lib/cronUtils";
import { SubAgentSteps } from "@/app/components/SubAgentSteps";
import {
  messagesToSubAgentSteps,
  type SubAgentStep,
} from "@/lib/subAgentActivity";

const STEPS_POLL_INTERVAL_MS = 2_500;

function formatRunDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function statusDotClass(record: ScheduledRunRecord): string {
  if (isActiveStatus(record.status)) {
    return "bg-[var(--color-success)] animate-pulse";
  }
  if (record.status === "success") return "bg-[var(--color-success)]";
  return "bg-[var(--color-error)]";
}

function statusLabel(record: ScheduledRunRecord, now: number): string {
  if (isActiveStatus(record.status)) {
    const elapsed = formatElapsed(record.started_at, now);
    return elapsed ? `Running… ${elapsed}` : "Running…";
  }
  const when = formatRunDate(record.started_at);
  const duration = record.ended_at
    ? formatElapsed(record.started_at, Date.parse(record.ended_at))
    : "";
  const failed = record.status !== "success" ? ` · ${record.status}` : "";
  return [when, duration].filter(Boolean).join(" · ") + failed;
}

export function ScheduledTaskActivity({ task }: { task: ScheduledTask }) {
  const { runs, loaded, error } = useScheduledTaskRuns(task);
  const [now, setNow] = useState(() => Date.now());
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [stepsByThread, setStepsByThread] = useState<
    Record<string, SubAgentStep[]>
  >({});
  const [stepsError, setStepsError] = useState<string | null>(null);
  const loadedStepsRef = useRef(new Set<string>());
  const hasActive = runs.some((r) => isActiveStatus(r.status));

  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasActive]);

  useEffect(() => {
    setExpandedThreadId(null);
    setStepsByThread({});
    setStepsError(null);
    loadedStepsRef.current.clear();
  }, [task.cron_id]);

  const expandedRecord = useMemo(
    () => runs.find((r) => r.thread_id === expandedThreadId) ?? null,
    [runs, expandedThreadId]
  );
  const expandedActive = expandedRecord
    ? isActiveStatus(expandedRecord.status)
    : false;
  const expandedUpdatedAt = expandedRecord?.thread_updated_at ?? null;

  useEffect(() => {
    if (!expandedThreadId) return;
    const signature = `${expandedThreadId}:${expandedUpdatedAt ?? ""}`;
    if (!expandedActive && loadedStepsRef.current.has(signature)) return;
    const client = makeClient();
    if (!client) return;
    let cancelled = false;
    const load = async () => {
      try {
        const state = (await client.threads.getState(expandedThreadId)) as {
          values?: { messages?: unknown[] };
        };
        if (cancelled) return;
        const messages = Array.isArray(state.values?.messages)
          ? state.values.messages
          : [];
        setStepsByThread((prev) => ({
          ...prev,
          [expandedThreadId]: messagesToSubAgentSteps(messages),
        }));
        setStepsError(null);
        if (!expandedActive) loadedStepsRef.current.add(signature);
      } catch {
        if (!cancelled) setStepsError("Couldn't load run steps.");
      }
    };
    load();
    const interval = expandedActive
      ? setInterval(load, STEPS_POLL_INTERVAL_MS)
      : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [expandedThreadId, expandedActive, expandedUpdatedAt]);

  const toggleExpanded = (threadId: string) => {
    setStepsError(null);
    setExpandedThreadId((current) => (current === threadId ? null : threadId));
  };

  return (
    <section className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Activity</p>
      <div className="rounded-md border border-border bg-[var(--color-surface)]">
        {!hasActive && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span
              className="size-2 shrink-0 rounded-full bg-[var(--color-text-tertiary,var(--muted-foreground))] opacity-40"
              aria-hidden="true"
            />
            <p className="min-w-0 truncate text-sm text-muted-foreground">
              {task.next_run_date
                ? `Next run ${nextRunLabel(
                    task.next_run_date
                  )} · ${formatRunDate(task.next_run_date)}`
                : "Not scheduled"}
            </p>
          </div>
        )}
        {error ? (
          <p
            className="px-3 py-2.5 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : !loaded ? (
          <div
            className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2
              className="size-3.5 animate-spin"
              aria-hidden="true"
            />
            Loading runs…
          </div>
        ) : runs.length === 0 ? (
          <p className="px-3 py-2.5 text-sm text-muted-foreground">
            No runs yet. Runs appear here after the schedule fires or you press
            Run now.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {runs.map((record) => {
              const expanded = record.thread_id === expandedThreadId;
              const steps = stepsByThread[record.thread_id];
              return (
                <div key={record.thread_id}>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(record.thread_id)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        statusDotClass(record)
                      )}
                      aria-hidden="true"
                    />
                    {record.status === "success" && (
                      <span className="sr-only">Completed: </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm tabular-nums">
                      {statusLabel(record, now)}
                    </span>
                    {record.trigger === "manual" && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        manual
                      </span>
                    )}
                    {expanded ? (
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {expanded && (
                    <div className="border-t border-border/60 px-3 py-2">
                      {stepsError ? (
                        <p
                          className="text-xs text-destructive"
                          role="alert"
                        >
                          {stepsError}
                        </p>
                      ) : !steps ? (
                        <div
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                          role="status"
                        >
                          <Loader2
                            className="size-3 animate-spin"
                            aria-hidden="true"
                          />
                          Loading steps…
                        </div>
                      ) : steps.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No steps recorded yet.
                        </p>
                      ) : (
                        <SubAgentSteps
                          steps={steps}
                          compact
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
