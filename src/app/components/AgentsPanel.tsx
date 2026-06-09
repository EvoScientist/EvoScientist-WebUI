"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { useClient } from "@/providers/ClientProvider";
import { cn } from "@/lib/utils";
import { extractStringFromMessageContent } from "@/app/utils/utils";
import {
  type EnrichedAsyncTask,
  ASYNC_STATUS_META,
  agentLabel,
  countRunning,
  formatElapsed,
  normalizeAsyncStatus,
} from "@/lib/asyncAgents";
import { useAsyncAgents } from "@/app/hooks/useAsyncAgents";

interface Step {
  kind: "ai" | "tool";
  text: string;
  tools: string[];
}

interface TaskDetail {
  loading: boolean;
  error: string | null;
  prompt: string;
  steps: Step[];
}

/** Turn a task thread's messages into a compact prompt + step list. */
function buildDetail(messages: unknown[]): { prompt: string; steps: Step[] } {
  let prompt = "";
  const steps: Step[] = [];
  for (const raw of messages) {
    const m = raw as {
      type?: string;
      content?: unknown;
      tool_calls?: { name?: string }[];
    };
    const text = extractStringFromMessageContent(
      m as Parameters<typeof extractStringFromMessageContent>[0]
    ).trim();
    if (m.type === "human") {
      if (!prompt && text) prompt = text;
      continue;
    }
    if (m.type === "ai") {
      const tools = (m.tool_calls ?? [])
        .map((tc) => tc.name ?? "")
        .filter(Boolean);
      if (text || tools.length) steps.push({ kind: "ai", text, tools });
    } else if (m.type === "tool") {
      steps.push({ kind: "tool", text, tools: [] });
    }
  }
  return { prompt, steps };
}

function StatusDot({ status }: { status: string }) {
  const meta = ASYNC_STATUS_META[normalizeAsyncStatus(status)];
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        meta.dot,
        meta.pulse && "animate-pulse"
      )}
      aria-hidden="true"
    />
  );
}

function elapsedOf(task: EnrichedAsyncTask, now: number): string {
  const running = normalizeAsyncStatus(task.liveStatus) === "running";
  const end = running ? now : task.endedAt ? Date.parse(task.endedAt) : now;
  return formatElapsed(task.startedAt ?? task.created_at, end);
}

/**
 * Right-inspector "Agents" board. Shows the background async sub-agents (writing
 * / data-analysis) the active conversation launched, with their REAL run status
 * and elapsed/duration; expand a task to see its live steps (from its own
 * thread). Polling is in {@link useAsyncAgents} and stops when this is unmounted
 * (i.e. the Agents tab is closed).
 */
export function AgentsPanel() {
  const client = useClient();
  const [threadId] = useQueryState("threadId");
  const { tasks, loaded, error, refresh } = useAsyncAgents(threadId);
  const [now, setNow] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});

  // Smooth elapsed-time ticker for running tasks.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Fetch the expanded task's own thread for its steps; re-fetch whenever the
  // task list refreshes (so a running task's steps stay live).
  useEffect(() => {
    if (!expandedId) return;
    const task = tasks.find((t) => t.task_id === expandedId);
    if (!task) return;
    let cancelled = false;
    setDetails((prev) => ({
      ...prev,
      [expandedId]: {
        loading: !prev[expandedId],
        error: null,
        prompt: prev[expandedId]?.prompt ?? "",
        steps: prev[expandedId]?.steps ?? [],
      },
    }));
    (async () => {
      try {
        const state = (await client.threads.getState(task.thread_id)) as {
          values?: { messages?: unknown[] };
        };
        if (cancelled) return;
        const { prompt, steps } = buildDetail(state.values?.messages ?? []);
        setDetails((prev) => ({
          ...prev,
          [expandedId]: { loading: false, error: null, prompt, steps },
        }));
      } catch {
        if (cancelled) return;
        setDetails((prev) => ({
          ...prev,
          [expandedId]: {
            loading: false,
            error: "Couldn't load this agent's steps.",
            prompt: prev[expandedId]?.prompt ?? "",
            steps: prev[expandedId]?.steps ?? [],
          },
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expandedId, tasks, client]);

  const runningCount = useMemo(() => countRunning(tasks), [tasks]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <p className="text-xs text-muted-foreground">
          {runningCount > 0
            ? `${runningCount} running`
            : tasks.length > 0
            ? `${tasks.length} total`
            : "Background agents"}
        </p>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh agents"
          title="Refresh"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw
            className="size-3.5"
            aria-hidden="true"
          />
        </button>
      </div>

      {error && (
        <p className="px-1 text-xs text-[var(--color-error)]">{error}</p>
      )}

      {!loaded && (
        <div className="flex items-center gap-2 px-1 py-4 text-xs text-muted-foreground">
          <Loader2
            className="size-4 animate-spin"
            aria-hidden="true"
          />
          Loading…
        </div>
      )}

      {loaded && tasks.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <Bot
            className="size-9 text-muted-foreground/60"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            No background agents yet.
          </p>
          <p className="text-xs text-muted-foreground/80">
            When EvoScientist delegates long tasks (writing, data analysis) they
            run in the background and show up here.
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {tasks.map((task) => {
          const meta = ASYNC_STATUS_META[normalizeAsyncStatus(task.liveStatus)];
          const expanded = expandedId === task.task_id;
          const detail = details[task.task_id];
          return (
            <div
              key={task.task_id}
              className="rounded-md border border-border bg-background"
            >
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : task.task_id)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-expanded={expanded}
              >
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
                <StatusDot status={task.liveStatus} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {agentLabel(task.agent_name)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {meta.label}
                  {(() => {
                    const e = elapsedOf(task, now);
                    return e ? ` · ${e}` : "";
                  })()}
                </span>
              </button>

              {expanded && (
                <div className="border-t border-border px-2.5 py-2 text-xs">
                  {detail?.loading && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2
                        className="size-3.5 animate-spin"
                        aria-hidden="true"
                      />
                      Loading steps…
                    </div>
                  )}
                  {detail?.error && (
                    <p className="text-[var(--color-error)]">{detail.error}</p>
                  )}
                  {detail && !detail.loading && !detail.error && (
                    <div className="flex flex-col gap-2">
                      {detail.prompt && (
                        <div>
                          <p className="font-semibold text-foreground">Task</p>
                          <p className="whitespace-pre-wrap break-words text-muted-foreground">
                            {detail.prompt.length > 600
                              ? detail.prompt.slice(0, 600) + "…"
                              : detail.prompt}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="font-semibold text-foreground">
                          Steps{" "}
                          <span className="font-normal text-muted-foreground">
                            ({detail.steps.length})
                          </span>
                        </p>
                        {detail.steps.length === 0 ? (
                          <p className="text-muted-foreground">No steps yet.</p>
                        ) : (
                          <ol className="mt-1 flex flex-col gap-1.5">
                            {detail.steps.slice(-40).map((step, i) => (
                              <li
                                key={i}
                                className="flex gap-2"
                              >
                                <span
                                  className={cn(
                                    "mt-1 size-1.5 shrink-0 rounded-full",
                                    step.kind === "tool"
                                      ? "bg-[var(--brand)]"
                                      : "bg-muted-foreground"
                                  )}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1">
                                  {step.tools.length > 0 && (
                                    <span className="font-mono text-[var(--brand)]">
                                      {step.tools.join(", ")}
                                    </span>
                                  )}
                                  {step.text && (
                                    <span
                                      className={cn(
                                        "block whitespace-pre-wrap break-words text-muted-foreground",
                                        step.tools.length > 0 && "mt-0.5"
                                      )}
                                    >
                                      {step.text.length > 240
                                        ? step.text.slice(0, 240) + "…"
                                        : step.text}
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
