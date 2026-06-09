// Async sub-agents (writing-agent / data-analysis-agent) run as SEPARATE
// background LangGraph threads+runs when EvoScientist's `enable_async_subagents`
// is on. The originating conversation tracks them in its thread state under the
// `async_tasks` key (deepagents' AsyncTask shape). The Agents board reads that to
// show which background agents a conversation launched, their status, and — on
// expand — their live steps (fetched from the task's own thread).
//
// Memory workers (evomemory-*-worker) are intentionally NOT shown here: they are
// ~2s ephemeral background runs whose only meaningful output (profile edits /
// observations) is already visible in the Memory panel.

export interface AsyncTaskItem {
  task_id: string;
  agent_name: string;
  thread_id: string;
  run_id: string;
  status: string;
  created_at?: string;
  last_updated_at?: string;
}

export type AsyncAgentStatus =
  | "running"
  | "success"
  | "error"
  | "cancelled"
  | "unknown";

/** Collapse the various SDK run statuses into the 5 we render. */
export function normalizeAsyncStatus(s: string | undefined): AsyncAgentStatus {
  switch (s) {
    case "running":
    case "pending":
    case "busy":
      return "running";
    case "success":
      return "success";
    case "error":
    case "timeout":
      return "error";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return "unknown";
  }
}

const AGENT_LABELS: Record<string, string> = {
  "writing-agent": "Writing agent",
  "data-analysis-agent": "Data analysis agent",
};

export function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? name;
}

// Theme dot + label + pulse per status. CSS vars referenced via arbitrary-value
// classes (the base's semantic bg tokens are dead in this fork — see CLAUDE.md).
// NOTE: never put a bracketed class literal in a comment (Tailwind scans those).
export const ASYNC_STATUS_META: Record<
  AsyncAgentStatus,
  { dot: string; label: string; pulse: boolean }
> = {
  running: { dot: "bg-[var(--color-warning)]", label: "Running", pulse: true },
  success: { dot: "bg-[var(--color-success)]", label: "Done", pulse: false },
  error: { dot: "bg-[var(--color-error)]", label: "Error", pulse: false },
  cancelled: {
    dot: "bg-muted-foreground",
    label: "Cancelled",
    pulse: false,
  },
  unknown: { dot: "bg-muted-foreground", label: "Unknown", pulse: false },
};

/** Read + validate the `async_tasks` map from a thread state's `values`. */
export function parseAsyncTasks(value: unknown): AsyncTaskItem[] {
  if (!value || typeof value !== "object") return [];
  const out: AsyncTaskItem[] = [];
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (typeof t.task_id !== "string" || typeof t.agent_name !== "string") {
      continue;
    }
    out.push({
      task_id: t.task_id,
      agent_name: t.agent_name,
      thread_id: typeof t.thread_id === "string" ? t.thread_id : t.task_id,
      run_id: typeof t.run_id === "string" ? t.run_id : "",
      status: typeof t.status === "string" ? t.status : "",
      created_at: typeof t.created_at === "string" ? t.created_at : undefined,
      last_updated_at:
        typeof t.last_updated_at === "string" ? t.last_updated_at : undefined,
    });
  }
  // Newest first (ISO-8601 strings sort lexicographically).
  out.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return out;
}

// An async task enriched with its REAL run status (from `runs.get`), so the
// board/indicator don't depend on the main agent calling check_async_task to
// refresh the cached `status` in conversation state (which otherwise stays
// "running" forever — the timer never stops).
export interface EnrichedAsyncTask extends AsyncTaskItem {
  liveStatus: string;
  startedAt?: string;
  endedAt?: string;
}

export function isTerminalStatus(s: string | undefined): boolean {
  const n = normalizeAsyncStatus(s);
  return n === "success" || n === "error" || n === "cancelled";
}

export function countRunning(
  tasks: { liveStatus?: string; status: string }[]
): number {
  return tasks.filter(
    (t) => normalizeAsyncStatus(t.liveStatus ?? t.status) === "running"
  ).length;
}

/** Elapsed "1m 23s" / "12s" between a start ISO time and an end (ms epoch). */
export function formatElapsed(
  startIso: string | undefined,
  endMs: number
): string {
  if (!startIso) return "";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "";
  const secs = Math.max(0, Math.round((endMs - start) / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    return `${h}h ${mins % 60}m`;
  }
  return mins > 0 ? `${mins}m ${rem}s` : `${secs}s`;
}

/** Compact relative time like "12s", "3m", "1h" from an ISO timestamp. */
export function relTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
