// Removing a project without leaving work out of sight:
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

/** How many of a project's assistants are read, at most: it has one per
 *  graph. */
const ASSISTANTS_LIMIT = 100;

/** What removing a project stops and pauses. */
export interface ProjectWork {
  /** Its threads with a run going: conversations, scheduled runs, agents. */
  running: Array<{ id: string; title: string }>;
  /** Its scheduled tasks that are on (not the hidden AutoSkills ones). */
  tasks: Array<{ id: string; name: string }>;
  /** Its assistants' IDs (see `projectAssistants`): the runs are found
   *  again by these once it is removed. */
  assistants: string[];
  /** False when the backend's list of them couldn't be read: runs on a
   *  graph the WebUI doesn't know can't have been found. */
  assistantsComplete: boolean;
}

/** The part of `ProjectWork` its runs are found again by. */
export type ProjectAssistants = Pick<
  ProjectWork,
  "assistants" | "assistantsComplete"
>;

function label(metadata: unknown, fallback: string): string {
  const md = (metadata ?? {}) as Record<string, unknown>;
  for (const key of ["title", "auto_title", "name"]) {
    const value = md[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

/** The IDs of the project at `key`'s assistants: one per graph the WebUI
 *  knows, and whatever else the backend lists for the folder (it stamps the
 *  folder on every one, whatever its graph). Without the backend's list,
 *  the known ones alone, and `complete` is false. */
async function projectAssistants(
  client: Client,
  key: string
): Promise<{ ids: string[]; complete: boolean }> {
  const listed = await client.assistants
    .search({
      metadata: { workspace_dir: key },
      limit: ASSISTANTS_LIMIT,
      select: ["assistant_id"],
    })
    .then(
      (assistants) => assistants.map((assistant) => assistant.assistant_id),
      () => null
    );
  return {
    ids: [...new Set([...projectAssistantIds(key), ...(listed ?? [])])],
    complete: listed !== null,
  };
}

/** The project's threads with a run going: every graph, so a scheduled
 *  run or an agent counts as much as a conversation. A thread is the
 *  project's by the folder it records or by the assistant it runs on (one
 *  of `assistants`): an async agent's thread is made without metadata, and
 *  its run adds only the graph and the assistant to it. */
async function runningThreads(
  client: Client,
  key: string,
  assistants: readonly string[]
): Promise<ProjectWork["running"]> {
  const scopes: Record<string, string>[] = [
    { workspace_dir: key },
    ...assistants.map((assistant_id) => ({ assistant_id })),
  ];
  const matches = await Promise.all(
    scopes.map(async (metadata) => {
      const found: ProjectWork["running"] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const threads = await client.threads.search({
          status: "busy",
          metadata,
          limit: PAGE,
          offset: page * PAGE,
          select: ["thread_id", "metadata"],
        });
        for (const thread of threads) {
          found.push({
            id: thread.thread_id,
            title: label(
              thread.metadata,
              `Thread ${thread.thread_id.slice(0, 8)}`
            ),
          });
        }
        if (threads.length < PAGE) break;
      }
      return found;
    })
  );
  // A conversation records the folder and runs on a project assistant.
  return [
    ...new Map(matches.flat().map((thread) => [thread.id, thread])).values(),
  ];
}

/** What removing the project at `key` would stop and pause. The backend
 *  counts a scheduled task by its assistant: one of the project's. */
export async function projectWork(
  client: Client,
  key: string
): Promise<ProjectWork> {
  const [{ assistants, assistantsComplete, running }, crons] =
    await Promise.all([
      projectAssistants(client, key).then(async ({ ids, complete }) => ({
        assistants: ids,
        assistantsComplete: complete,
        running: await runningThreads(client, key, ids),
      })),
      client.crons.search({
        metadata: { run_kind: SCHEDULED_RUN_KIND },
        enabled: true,
        limit: 1000,
      }),
    ]);
  const own = new Set(assistants);
  const tasks = crons
    .filter(
      (cron) =>
        cron.enabled !== false &&
        cron.assistant_id !== null &&
        own.has(cron.assistant_id)
    )
    .map((cron) => ({
      id: cron.cron_id,
      name: label(cron.metadata, "Unnamed task"),
    }));
  return { running, tasks, assistants, assistantsComplete };
}

/** How stopping a project's runs went. */
export interface StopRunsResult {
  /** The threads whose runs couldn't be cancelled. */
  unstopped: ProjectWork["running"];
  /** False when its running threads couldn't be read (the `known` ones
   *  were tried), or when its assistants were known only in part (the
   *  threads found were tried): those that failed are in `unstopped`, and
   *  others may be going. */
  checked: boolean;
}

/** Stop the runs going in the project at `key`, as far as it can: its
 *  threads, by its folder and by its assistants (from `projectWork`). When
 *  that list was incomplete, the backend's list is asked for again. */
export async function stopProjectRuns(
  client: Client,
  key: string,
  { assistants, assistantsComplete }: ProjectAssistants,
  known: ProjectWork["running"]
): Promise<StopRunsResult> {
  let ids: readonly string[] = assistants;
  let complete = assistantsComplete;
  if (!complete) {
    const again = await projectAssistants(client, key);
    ids = [...new Set([...assistants, ...again.ids])];
    complete = again.complete;
  }
  const { running, checked } = await runningThreads(client, key, ids).then(
    (found) => ({ running: found, checked: complete }),
    () => ({ running: known, checked: false })
  );
  const stopped = await Promise.all(
    running.map((thread) =>
      cancelActiveRuns(client as unknown as RunCancelClient, thread.id)
    )
  );
  return {
    unstopped: running.filter((_, i) => !stopped[i]),
    checked,
  };
}

/** How removing a project and its work went: once removed, how stopping
 *  its runs went. */
export type RemoveProjectAndWorkResult =
  | ({ ok: true } & StopRunsResult)
  | Extract<RemoveProjectResult, { ok: false }>;

/**
 * Remove the project at `key`: pause its scheduled tasks, remove it, then
 * stop its runs. After the removal the backend refuses new runs in the
 * project, so none can start between the stop and the removal.
 *
 * When the removal fails, the tasks it paused are turned on again and no run
 * is stopped, unless the project is gone anyway (the backend has no such
 * project, or `isRegistered` says no: the backend finished after the request
 * timed out, or another tab removed it); then the runs are stopped as after
 * a removal.
 */
export async function removeProjectAndWork(
  client: Client,
  key: string,
  work: ProjectWork,
  isRegistered: () => Promise<boolean>
): Promise<RemoveProjectAndWorkResult> {
  const paused = (
    await Promise.allSettled(
      work.tasks.map((task) =>
        client.crons.update(task.id, { enabled: false }).then(() => task.id)
      )
    )
  ).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const result = await removeProject(key);
  if (result.ok || result.gone || !(await isRegistered().catch(() => true))) {
    return {
      ok: true,
      ...(await stopProjectRuns(client, key, work, work.running)),
    };
  }
  await Promise.allSettled(
    paused.map((id) => client.crons.update(id, { enabled: true }))
  );
  return result;
}
