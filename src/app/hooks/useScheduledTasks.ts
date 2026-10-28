"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Cron } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk";
import { getConfig } from "@/lib/config";
import { browserTimeZone } from "@/lib/cronUtils";
import { patchClientStreamModes } from "@/lib/streamMode";
import { getHttpStatus, isRunFolderMismatchError } from "@/lib/streamError";
import {
  SCHEDULER_GRAPH_ID,
  workspaceAssistantId,
} from "@/lib/workspaceAssistant";
import { useProjects } from "@/providers/ProjectsProvider";

/** The `run_kind` the WebUI and the core give a scheduled task. */
export const SCHEDULED_RUN_KIND = "scheduled_task";

/** Where scheduled tasks run: the scheduler graph's assistant for a
 *  project, and that project's folder for the task's tag. */
export interface SchedulerTarget {
  assistantId: string;
  workspaceDir: string;
}

function workspaceTag(target: SchedulerTarget): Record<string, string> {
  return { workspace_dir: target.workspaceDir };
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
  /** False while the task is paused: it keeps its schedule but doesn't run. */
  enabled: boolean;
  input: Record<string, unknown>;
}

/** When `task` runs next; null while it is paused or has no next run. */
export function upcomingRun(task: ScheduledTask): string | null {
  return task.enabled ? task.next_run_date : null;
}

/**
 * Why `task` can't be run from here: it runs in another project than the
 * current one, and a manual run would run it in this one. Null when it can.
 * An untagged task counts as the current project's.
 */
export function otherFolderReason(
  task: ScheduledTask,
  currentFolder: string | null
): string | null {
  if (!task.workspaceDir || !currentFolder) return null;
  if (task.workspaceDir === currentFolder) return null;
  return `This task runs in ${task.workspaceDir}, not the current project.`;
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
    enabled: cron.enabled !== false,
    input: storedInput(cron),
  };
}

function storedInput(cron: Cron): Record<string, unknown> {
  const input = cron.payload?.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
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

/**
 * Edit a task in place: it keeps its ID, its folder's assistant, its run
 * history and whether it is paused. The server merges `metadata` into the
 * stored one and replaces `input`.
 */
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
  input: Record<string, unknown>;
}): Promise<ScheduledTask> {
  const client = makeClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  const cron = await client.crons.update(params.cronId, {
    input: {
      ...params.input,
      messages: [{ role: "user", content: params.prompt }],
    },
    schedule: params.schedule,
    timezone: params.timezone || browserTimeZone(),
    metadata: { name: params.name, prompt: params.prompt },
  });
  return parseCron(cron);
}

/**
 * Pause a task (it keeps its schedule but doesn't run) or resume it. A pause
 * leaves the next run date where it was, so the server would fire a resumed
 * task at once for a time missed while paused; resuming sends the schedule
 * again, which makes the server count the next run from now.
 */
export async function setScheduledTaskEnabled(
  task: Pick<ScheduledTask, "cron_id" | "schedule">,
  enabled: boolean
): Promise<ScheduledTask> {
  const client = makeClient();
  if (!client) throw new Error("No EvoScientist deployment configured.");
  const cron = await client.crons.update(
    task.cron_id,
    enabled ? { enabled, schedule: task.schedule } : { enabled }
  );
  return parseCron(cron);
}

export function scheduledTaskMissing(error: unknown): boolean {
  return getHttpStatus(error) === 404;
}

export async function runScheduledTaskNow(
  task: {
    cron_id: string;
    name: string;
    prompt: string;
    /** The task's stored run input: a rubric in it grades the run. */
    input: Record<string, unknown>;
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
    input: {
      ...task.input,
      messages: [{ role: "user", content: task.prompt }],
    },
    metadata,
    config: { configurable: { cron_id: task.cron_id } },
  });
}

/** The current project's folder; null when there is none. */
export function useCurrentFolder(): string | null {
  return useProjects().current?.key ?? null;
}

/**
 * Whether a failed create or run means the projects must be read again. Save
 * and Run now create the cron or thread they run on, so a 404 can only be
 * the assistant: the core makes every registered project's assistants, so
 * the project is gone. `crons.create` says so as `Assistant '<id>' not
 * found`, a run as `Thread or assistant not found.`. A folder refusal says
 * the backend doesn't serve the project.
 */
export function assistantRecoveryNeeded(error: unknown): boolean {
  return getHttpStatus(error) === 404 || isRunFolderMismatchError(error);
}

/** Handle a failed create or run: read the projects again when it needs
 *  to. */
export function useAssistantRecovery(): (error: unknown) => void {
  const { refresh } = useProjects();
  return useCallback(
    (error: unknown) => {
      if (assistantRecoveryNeeded(error)) void refresh();
    },
    [refresh]
  );
}

/** Whether a task may be created or run now (the projects are not being
 *  read again); check it at the moment of acting. */
export function useSchedulerGate(): () => boolean {
  return useProjects().isReady;
}

/** The scheduler assistant for the current project; null when there is
 *  none, or while the projects are read again. */
export function useSchedulerTarget(): SchedulerTarget | null {
  const { current, refreshing } = useProjects();
  const workspaceDir = refreshing ? null : current?.key ?? null;
  return useMemo(
    () =>
      workspaceDir
        ? {
            assistantId: workspaceAssistantId(SCHEDULER_GRAPH_ID, workspaceDir),
            workspaceDir,
          }
        : null,
    [workspaceDir]
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
  const requestRev = useRef(0);

  // Loading from the call on, in the same render as what the caller sets
  // with it: nothing reads the list as current until the new read is in.
  const refresh = useCallback(() => {
    requestRev.current += 1;
    setLoading(true);
    setRev((r) => r + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listScheduledTasks()
      .then((result) => {
        if (!cancelled && requestRev.current === rev) {
          setTasks(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && requestRev.current === rev) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load scheduled tasks."
          );
          setTasks([]);
        }
      })
      .finally(() => {
        if (!cancelled && requestRev.current === rev) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rev]);

  return { tasks, loading, error, refresh };
}
