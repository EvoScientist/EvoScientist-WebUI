"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Cron } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk";
import { getConfig } from "@/lib/config";
import { browserTimeZone } from "@/lib/cronUtils";
import { patchClientStreamModes } from "@/lib/streamMode";
import {
  isMissingThreadOrAssistantError,
  isRunFolderMismatchError,
} from "@/app/hooks/useChat";
import { SCHEDULER_GRAPH_ID } from "@/lib/workspaceAssistant";
import { useWorkspace } from "@/providers/WorkspaceProvider";
import { assistantIdFor } from "@/lib/workspaceSession";

const SCHEDULED_RUN_KIND = "scheduled_task";

/** Where scheduled tasks run: the scheduler graph's assistant for the
 *  backend's folder, and that folder for the task's tag. */
export interface SchedulerTarget {
  assistantId: string;
  /** Null on a backend without the workspace route. */
  workspaceDir: string | null;
}

function workspaceTag(target: SchedulerTarget): Record<string, string> {
  return target.workspaceDir ? { workspace_dir: target.workspaceDir } : {};
}

export function makeClient(): Client | null {
  const config = getConfig();
  if (!config) return null;
  const apiKey =
    config.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
  return patchClientStreamModes(
    new Client({
      apiUrl: config.deploymentUrl,
      defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
    })
  );
}

export interface ScheduledTask {
  cron_id: string;
  name: string;
  prompt: string;
  schedule: string;
  /** IANA zone the schedule runs in; null means the server's default, UTC. */
  timezone: string | null;
  next_run_date: string | null;
  created_at: string;
  updated_at: string;
  /** The folder the task runs in; null for a task made before tags. */
  workspaceDir: string | null;
}

/**
 * Why `task` can't be edited or run from here: it runs in another folder
 * than the backend's, and editing or running it would move it to this one.
 * Null when it can. An untagged task counts as this folder's, as the core's
 * scheduling does.
 */
export function otherFolderReason(
  task: ScheduledTask,
  servedFolder: string | null
): string | null {
  if (!task.workspaceDir || !servedFolder) return null;
  if (task.workspaceDir === servedFolder) return null;
  return `This task runs in ${task.workspaceDir}, not the backend's folder.`;
}

function parseCron(cron: Cron): ScheduledTask {
  const meta = (cron.metadata ?? {}) as Record<string, unknown>;
  return {
    cron_id: cron.cron_id,
    name:
      typeof meta.name === "string" && meta.name ? meta.name : "Unnamed Task",
    prompt: typeof meta.prompt === "string" ? meta.prompt : "",
    schedule: cron.schedule,
    timezone: cron.timezone || null,
    next_run_date: cron.next_run_date ?? null,
    created_at: cron.created_at,
    updated_at: cron.updated_at,
    workspaceDir:
      typeof meta.workspace_dir === "string" && meta.workspace_dir
        ? meta.workspace_dir
        : null,
  };
}

export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const client = makeClient();
  if (!client) return [];
  // Only EvoScientist crons carry run_kind in metadata. Scoping the list to
  // the backend's folder comes with the project sidebar.
  const crons = await client.crons.search({ limit: 200 });
  const scheduledCrons = crons.filter(
    (c) =>
      (c.metadata as Record<string, unknown>)?.run_kind === SCHEDULED_RUN_KIND
  );

  await Promise.allSettled(
    scheduledCrons
      .filter((cron) => cron.on_run_completed !== "keep")
      .map((cron) =>
        client.crons.update(cron.cron_id, { onRunCompleted: "keep" })
      )
  );

  return scheduledCrons.map(parseCron);
}

export async function createScheduledTask(params: {
  name: string;
  prompt: string;
  schedule: string;
  /** Defaults to the browser's time zone. */
  timezone?: string | null;
  target: SchedulerTarget;
}): Promise<ScheduledTask> {
  const client = makeClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  const cron = await client.crons.create(params.target.assistantId, {
    input: { messages: [{ role: "user", content: params.prompt }] },
    schedule: params.schedule,
    // Without a time zone the server reads the schedule in UTC.
    timezone: params.timezone || browserTimeZone(),
    onRunCompleted: "keep",
    metadata: {
      run_kind: SCHEDULED_RUN_KIND,
      name: params.name,
      prompt: params.prompt,
      ...workspaceTag(params.target),
    },
  });
  return parseCron(cron as unknown as Cron);
}

export async function deleteScheduledTask(cronId: string): Promise<void> {
  const client = makeClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  await client.crons.delete(cronId);
}

export async function updateScheduledTask(params: {
  cronId: string;
  name: string;
  prompt: string;
  schedule: string;
  /**
   * The task's current time zone, which the edit keeps. A task stored without
   * one (made before #61, meant as local time) moves to the browser's.
   */
  timezone: string | null;
  target: SchedulerTarget;
}): Promise<{ task: ScheduledTask; oldTaskDeleted: boolean }> {
  const task = await createScheduledTask({
    name: params.name,
    prompt: params.prompt,
    schedule: params.schedule,
    timezone: params.timezone,
    target: params.target,
  });

  try {
    await deleteScheduledTask(params.cronId);
    return { task, oldTaskDeleted: true };
  } catch {
    return { task, oldTaskDeleted: false };
  }
}

export async function runScheduledTaskNow(
  task: {
    cron_id: string;
    name: string;
    prompt: string;
  },
  target: SchedulerTarget
): Promise<void> {
  const client = makeClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  const metadata = {
    run_kind: SCHEDULED_RUN_KIND,
    cron_id: task.cron_id,
    trigger: "manual",
    name: task.name,
    prompt: task.prompt,
    ...workspaceTag(target),
  };
  const thread = await client.threads.create({
    graphId: SCHEDULER_GRAPH_ID,
    metadata,
  });
  await client.runs.create(thread.thread_id, target.assistantId, {
    input: { messages: [{ role: "user", content: task.prompt }] },
    metadata,
    config: { configurable: { cron_id: task.cron_id } },
  });
}

/** The backend's folder; null until known, or on a backend without the
 *  workspace route. */
export function useServedFolder(): string | null {
  const { workspace } = useWorkspace();
  return workspace.status === "ready" ? workspace.key : null;
}

/**
 * Handle a failed create or run: a 404 for the assistant means the backend
 * lost this folder's assistants (a fresh store), and a folder mismatch means
 * it serves another folder now; either way the folder is read again.
 */
export function useAssistantRecovery(): (error: unknown) => void {
  const { refresh } = useWorkspace();
  return useCallback(
    (error: unknown) => {
      if (
        isMissingThreadOrAssistantError(error) ||
        isRunFolderMismatchError(error)
      ) {
        void refresh();
      }
    },
    [refresh]
  );
}

/** Whether a task may be created or run now (the folder is not being read
 *  again); check it at the moment of acting. */
export function useSchedulerGate(): () => boolean {
  return useWorkspace().isReady;
}

/** The scheduler assistant for the backend's folder; null until known. */
export function useSchedulerTarget(): SchedulerTarget | null {
  const { workspace, refreshing } = useWorkspace();
  // None while the folder is read again: tasks wait for its answer.
  const assistantId = refreshing
    ? null
    : assistantIdFor(workspace, SCHEDULER_GRAPH_ID);
  const workspaceDir = workspace.status === "ready" ? workspace.key : null;
  return useMemo(
    () => (assistantId ? { assistantId, workspaceDir } : null),
    [assistantId, workspaceDir]
  );
}

export function useScheduledTasks(): {
  tasks: ScheduledTask[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  const refresh = useCallback(() => setRev((r) => r + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listScheduledTasks()
      .then((result) => {
        if (!cancelled) {
          setTasks(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load scheduled tasks."
          );
          setTasks([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rev]);

  return { tasks, loading, error, refresh };
}
