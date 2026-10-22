// The check before the app stops a backend it started (closing, "Restart
// backend"): busy threads, running background jobs and enabled scheduled
// tasks, each probe with a short timeout. A probe that fails or times out
// gives "unknown", which still lets the user quit. Then, after the window is
// hidden, the wait for the memory workers (D4).
import { loopbackJson, type JsonResponse } from "./loopback";
import { sleep } from "./proc";

export const PROBE_TIMEOUT_MS = 2_000;
/** Busy threads read in one probe; more than this still means "busy". */
export const BUSY_LIMIT = 100;
const CRON_PAGE = 100;
const CRON_MAX_PAGES = 20;

/** Memory workers and the proactive check run on their own threads after
 *  almost every turn (or every 10 minutes); they are not work in progress. */
export function isBackgroundThread(
  runKind: unknown
): "memory" | "proactive" | null {
  if (typeof runKind !== "string") return null;
  if (runKind.startsWith("evomemory_")) return "memory";
  if (runKind === "proactive_check") return "proactive";
  return null;
}

const runKindOf = (item: unknown): unknown =>
  item && typeof item === "object"
    ? (item as { metadata?: { run_kind?: unknown } }).metadata?.run_kind
    : undefined;

export type Request = (
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number }
) => Promise<JsonResponse>;

export const backendRequest =
  (baseUrl: string): Request =>
  (path, opts) =>
    loopbackJson(new URL(path, baseUrl).toString(), opts);

export type WorkCheck =
  | {
      kind: "known";
      /** Busy threads that are not memory workers or the proactive check. */
      busyThreads: number;
      /** Names of running background jobs. */
      jobs: string[];
      /** Enabled crons whose run_kind is scheduled_task. */
      scheduledTasks: number;
    }
  | { kind: "unknown"; reason: string };

export const hasWork = (c: WorkCheck): boolean =>
  c.kind === "unknown" ||
  c.busyThreads > 0 ||
  c.jobs.length > 0 ||
  c.scheduledTasks > 0;

function ok(r: JsonResponse, what: string): unknown {
  if (r.status !== 200) throw new Error(`${what} answered ${r.status}`);
  return r.body;
}

async function busyThreads(req: Request): Promise<unknown[]> {
  const body = ok(
    await req("/threads/search", {
      method: "POST",
      body: { status: "busy", limit: BUSY_LIMIT },
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
    "threads/search"
  );
  if (!Array.isArray(body))
    throw new Error("threads/search did not answer a list");
  return body;
}

async function runningJobs(req: Request): Promise<string[]> {
  const body = ok(
    await req("/api/bg_processes/running", { timeoutMs: PROBE_TIMEOUT_MS }),
    "bg_processes/running"
  ) as {
    running?: unknown;
  };
  if (!body || !Array.isArray(body.running))
    throw new Error("bg_processes/running has no list");
  return body.running.map((j) =>
    j &&
    typeof j === "object" &&
    typeof (j as { name?: unknown }).name === "string"
      ? (j as { name: string }).name
      : String((j as { process_id?: unknown })?.process_id ?? "?")
  );
}

/** Enabled scheduled tasks, all pages. The filter is sent to the server and
 *  applied again here, so a server that ignores it still counts right. */
async function scheduledTasks(req: Request): Promise<number> {
  let count = 0;
  for (let page = 0; page < CRON_MAX_PAGES; page++) {
    const body = ok(
      await req("/runs/crons/search", {
        method: "POST",
        body: {
          enabled: true,
          metadata: { run_kind: "scheduled_task" },
          limit: CRON_PAGE,
          offset: page * CRON_PAGE,
        },
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
      "runs/crons/search"
    );
    if (!Array.isArray(body))
      throw new Error("runs/crons/search did not answer a list");
    count += body.filter(
      (c) =>
        runKindOf(c) === "scheduled_task" &&
        (c as { enabled?: unknown }).enabled !== false
    ).length;
    if (body.length < CRON_PAGE) return count;
  }
  return count;
}

export async function checkWork(req: Request): Promise<WorkCheck> {
  try {
    const [threads, jobs, tasks] = await Promise.all([
      busyThreads(req),
      runningJobs(req),
      scheduledTasks(req),
    ]);
    return {
      kind: "known",
      busyThreads: threads.filter(
        (t) => isBackgroundThread(runKindOf(t)) === null
      ).length,
      jobs,
      scheduledTasks: tasks,
    };
  } catch (e) {
    return {
      kind: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** How many memory-worker threads are busy, or null when the backend did not answer. */
export async function busyMemoryWorkers(req: Request): Promise<number | null> {
  try {
    return (await busyThreads(req)).filter(
      (t) => isBackgroundThread(runKindOf(t)) === "memory"
    ).length;
  } catch {
    return null;
  }
}

export const MEMORY_WAIT_MS = 120_000;
/** None busy for this long in a row counts as done: the observation linker
 *  starts only after a worker finished, from a watcher that polls every 1 s
 *  and then creates the linker's thread and run (D4). */
export const MEMORY_QUIET_MS = 3_000;
export const MEMORY_POLL_MS = 500;

export type MemoryWaitResult =
  | "quiet"
  | "timeout"
  | "unreachable"
  | "cancelled";

/**
 * Waits until no memory worker has been busy for MEMORY_QUIET_MS, at most
 * MEMORY_WAIT_MS in total. A backend that stops answering ends the wait.
 * `cancelled()` is checked between polls: a second launch or the end of the
 * session cancels the wait.
 */
export async function waitForMemoryWorkers(
  req: Request,
  opts: {
    cancelled: () => boolean;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
  }
): Promise<MemoryWaitResult> {
  const now = opts.now ?? Date.now;
  const pause = opts.pause ?? sleep;
  const deadline = now() + MEMORY_WAIT_MS;
  let quietSince: number | null = null;
  for (;;) {
    if (opts.cancelled()) return "cancelled";
    const busy = await busyMemoryWorkers(req);
    if (busy === null) return "unreachable";
    const t = now();
    if (busy > 0) quietSince = null;
    else if (quietSince === null) quietSince = t;
    if (quietSince !== null && t - quietSince >= MEMORY_QUIET_MS)
      return "quiet";
    if (t >= deadline) return "timeout";
    await pause(MEMORY_POLL_MS);
  }
}
