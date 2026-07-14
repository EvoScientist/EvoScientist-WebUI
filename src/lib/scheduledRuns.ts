export type ScheduledRunStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "timeout"
  | "interrupted";

export interface ScheduledRunRecord {
  thread_id: string;
  run_id: string | null;
  status: ScheduledRunStatus;
  trigger: "cron" | "manual";
  started_at: string;
  ended_at: string | null;
  thread_updated_at: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeRunStatus(status: unknown): ScheduledRunStatus {
  switch (status) {
    case "pending":
    case "running":
    case "success":
    case "error":
    case "timeout":
    case "interrupted":
      return status;
    default:
      return "error";
  }
}

export function isActiveStatus(status: ScheduledRunStatus): boolean {
  return status === "pending" || status === "running";
}

export function runMatchesTask(
  run: unknown,
  threadMetadata: unknown,
  task: { cron_id: string; prompt: string }
): boolean {
  const threadMeta = asRecord(threadMetadata);
  if (threadMeta.cron_id === task.cron_id) return true;
  const runObj = asRecord(run);
  const runMeta = asRecord(runObj.metadata);
  if (runMeta.cron_id === task.cron_id) return true;
  const configurable = asRecord(
    asRecord(asRecord(runObj.kwargs).config).configurable
  );
  if (configurable.cron_id === task.cron_id) return true;
  return (
    runMeta.run_kind === "scheduled_task" &&
    typeof runMeta.prompt === "string" &&
    runMeta.prompt !== "" &&
    runMeta.prompt === task.prompt
  );
}

export function buildRunRecord(
  run: unknown,
  thread: {
    thread_id: string;
    created_at?: string;
    updated_at?: string;
    metadata?: unknown;
  }
): ScheduledRunRecord {
  const runObj = asRecord(run);
  const runMeta = asRecord(runObj.metadata);
  const threadMeta = asRecord(thread.metadata);
  const status = normalizeRunStatus(runObj.status);
  const runCreatedAt =
    typeof runObj.created_at === "string" ? runObj.created_at : null;
  const runUpdatedAt =
    typeof runObj.updated_at === "string" ? runObj.updated_at : null;
  const startedAt =
    runCreatedAt ?? thread.created_at ?? new Date(0).toISOString();
  const endedAt = isActiveStatus(status)
    ? null
    : runUpdatedAt ?? thread.updated_at ?? null;
  const trigger =
    threadMeta.trigger === "manual" || runMeta.name === "manual-run"
      ? "manual"
      : "cron";
  return {
    thread_id: thread.thread_id,
    run_id: typeof runObj.run_id === "string" ? runObj.run_id : null,
    status,
    trigger,
    started_at: startedAt,
    ended_at: endedAt,
    thread_updated_at: thread.updated_at ?? null,
  };
}
