// Removing a project from the sidebar without leaving work out of sight:
// the conversations it has running and the scheduled tasks it has on, and
// the order the removal takes.

import type { Client } from "@langchain/langgraph-sdk";
import { removeProject, type RemoveProjectResult } from "@/lib/projectActions";
import { cancelActiveRuns, type RunCancelClient } from "@/lib/threadLifecycle";
import { projectAssistantIds } from "@/lib/projects";
import { SCHEDULED_RUN_KIND } from "@/app/hooks/useScheduledTasks";

/** Pages the running threads are read in, and how many at most. */
const PAGE = 100;
const MAX_PAGES = 10;

/** What removing a project stops and pauses. */
export interface ProjectWork {
  /** Its threads with a run going: conversations, scheduled runs, agents. */
  running: Array<{ id: string; title: string }>;
  /** Its scheduled tasks that are on (not the hidden AutoSkills ones). */
  tasks: Array<{ id: string; name: string }>;
}

function label(metadata: unknown, fallback: string): string {
  const md = (metadata ?? {}) as Record<string, unknown>;
  for (const key of ["title", "auto_title", "name"]) {
    const value = md[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

/** The project's threads with a run going: every graph, so a scheduled
 *  run or an agent counts as much as a conversation. */
async function runningThreads(client: Client, key: string) {
  const found: Array<{ id: string; title: string }> = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const threads = await client.threads.search({
      status: "busy",
      metadata: { workspace_dir: key },
      limit: PAGE,
      offset: page * PAGE,
    });
    for (const thread of threads) {
      found.push({
        id: thread.thread_id,
        title: label(thread.metadata, `Thread ${thread.thread_id.slice(0, 8)}`),
      });
    }
    if (threads.length < PAGE) break;
  }
  return found;
}

/** What removing the project at `key` would stop and pause. The backend
 *  counts a scheduled task by its assistant: one of the project's. */
export async function projectWork(
  client: Client,
  key: string
): Promise<ProjectWork> {
  const assistants = new Set(projectAssistantIds(key));
  const [running, crons] = await Promise.all([
    runningThreads(client, key),
    client.crons.search({
      metadata: { run_kind: SCHEDULED_RUN_KIND },
      enabled: true,
      limit: 1000,
    }),
  ]);
  const tasks = crons
    .filter(
      (cron) =>
        cron.enabled !== false &&
        cron.assistant_id !== null &&
        assistants.has(cron.assistant_id)
    )
    .map((cron) => ({
      id: cron.cron_id,
      name: label(cron.metadata, "Unnamed task"),
    }));
  return { running, tasks };
}

/** Stop the runs going in the project at `key` (`known`: if they can't be
 *  read again). */
async function stopRuns(
  client: Client,
  key: string,
  known: ProjectWork["running"]
) {
  const running = await runningThreads(client, key).catch(() => known);
  await Promise.allSettled(
    running.map((thread) =>
      cancelActiveRuns(client as unknown as RunCancelClient, thread.id)
    )
  );
}

/**
 * Remove the project at `key`: pause its scheduled tasks, remove it, then
 * stop its runs. After the removal the backend refuses new runs in the
 * project, so none can start between the stop and the removal.
 *
 * When the removal fails, the tasks it paused are turned on again and no run
 * is stopped, unless the project is gone anyway (`isRegistered` says no:
 * the backend finished after the request timed out, or another tab removed
 * it); then the runs are stopped as after a removal.
 */
export async function removeProjectAndWork(
  client: Client,
  key: string,
  work: ProjectWork,
  isRegistered: () => Promise<boolean>
): Promise<RemoveProjectResult> {
  const paused = (
    await Promise.allSettled(
      work.tasks.map((task) =>
        client.crons.update(task.id, { enabled: false }).then(() => task.id)
      )
    )
  ).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const result = await removeProject(key);
  if (result.ok || !(await isRegistered().catch(() => true))) {
    await stopRuns(client, key, work.running);
    return { ok: true };
  }
  await Promise.allSettled(
    paused.map((id) => client.crons.update(id, { enabled: true }))
  );
  return result;
}
