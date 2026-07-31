"use client";

import { useMemo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useSubThreadState } from "@/app/hooks/useSubThreadState";
import { messagesToSubAgentSteps } from "@/lib/subAgentActivity";
import {
  computeToolCount,
  computeTokenTotals,
  formatTokenCount,
  lastUpdatedAt,
} from "@/lib/personaMetrics";
import { formatTeamName } from "@/lib/teams";
import { SubAgentSteps } from "@/app/components/SubAgentSteps";
import { PhasedTodoCard } from "@/app/components/PhasedTodoCard";

interface PersonaFocusViewProps {
  /** The sub-thread being focused. Falsy → nothing rendered (caller
   *  shouldn't mount the view in that case; guard is defensive). */
  subThreadId: string;
  /** Display name for the header strip. Composer passes the deduped
   *  agent_name (== skill name), which we format via `formatTeamName`. */
  agentName: string;
  /** Live status label for the header right column. Composer derives this
   *  from `useAsyncAgents` (`Running…` when the task is still in flight,
   *  `Completed current work` when terminal). Null hides the label. */
  statusLabel?: string | null;
  /** True while the run is still executing — drives the header dot's pulse. */
  running?: boolean;
}

/**
 * Per-persona view. Replaces the main-thread messages when a persona chip is
 * clicked.
 * Composition:
 *  - Header metrics strip (`Team: … · Updated: HH:MM · Tools: N · in Xk · out Yk`).
 *  - Phased todos card (from sub-thread `values.todos`).
 *  - Sub-thread step timeline (reuses `SubAgentSteps`, same rendering as the
 *    Agents inspector board — tool calls with args + paired results + AI text).
 *
 * Data source is the polled `useSubThreadState(subThreadId)` — no live SSE
 * stream (see hook docstring for why). The Return-to-main pill and the
 * disabled composer are ChatInterface's responsibility; this view assumes
 * a caller already established focus.
 */
export function PersonaFocusView({
  subThreadId,
  agentName,
  statusLabel,
  running = false,
}: PersonaFocusViewProps) {
  const { state, loading, error, expired } = useSubThreadState(subThreadId);
  // Memoize on the stable object identity — `state` only changes when a poll
  // lands with new content, so both derivations settle to O(N) per poll
  // instead of O(N) per render.
  const messages = useMemo(() => state?.values.messages ?? [], [state]);
  const todos = useMemo(() => state?.values.todos ?? [], [state]);

  const metrics = useMemo(() => {
    const tokens = computeTokenTotals(messages);
    return {
      tools: computeToolCount(messages),
      inTokens: tokens.input,
      outTokens: tokens.output,
      updatedIso: lastUpdatedAt(messages),
    };
  }, [messages]);

  const steps = useMemo(() => messagesToSubAgentSteps(messages), [messages]);

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {formatTeamName(agentName)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span className="text-muted-foreground">Team:</span>{" "}
          <span className="font-mono">{agentName}</span>
        </span>
        {metrics.updatedIso && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              <span className="text-muted-foreground">Updated:</span>{" "}
              {formatClock(metrics.updatedIso)}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span>
          <span className="text-muted-foreground">Tools:</span> {metrics.tools}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span className="text-muted-foreground">in</span>{" "}
          {formatTokenCount(metrics.inTokens)} ·{" "}
          <span className="text-muted-foreground">out</span>{" "}
          {formatTokenCount(metrics.outTokens)}
        </span>
        {statusLabel && (
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className={`size-2 rounded-full ${
                running
                  ? "animate-pulse bg-[var(--color-warning)]"
                  : "bg-[var(--color-success)]"
              }`}
              aria-hidden="true"
            />
            <span className="font-medium text-[var(--brand)]">
              {statusLabel}
            </span>
          </span>
        )}
      </header>

      {expired && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-border bg-muted/60 p-3 text-sm text-muted-foreground"
        >
          <AlertCircle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div>
            This expert&apos;s workspace is no longer available (the backend
            restarted while it was running). Its output is gone; return to the
            main conversation to re-summon.
          </div>
        </div>
      )}

      {error && !expired && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {todos.length > 0 && <PhasedTodoCard todos={todos} />}

      {loading && steps.length === 0 && !expired && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2
            className="size-4 animate-spin"
            aria-hidden="true"
          />
          Loading expert activity…
        </div>
      )}

      {!loading && steps.length === 0 && !expired && !error && (
        <p className="text-sm text-muted-foreground">
          This expert hasn&apos;t produced any activity yet.
        </p>
      )}

      {steps.length > 0 && (
        <SubAgentSteps
          steps={steps}
          foldable
          isStreaming={running}
        />
      )}
    </div>
  );
}

/** Format an ISO timestamp as HH:MM (24h, local time). */
function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}
