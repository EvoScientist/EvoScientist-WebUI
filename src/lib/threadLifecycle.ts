import { getHttpStatus } from "@/lib/streamError";

export interface RunCancelClient {
  runs: {
    list(
      threadId: string,
      options?: { status?: string; limit?: number }
    ): Promise<Array<{ run_id: string }>>;
    cancel(threadId: string, runId: string): Promise<void>;
  };
}

const CANCELABLE_RUN_STATUSES = ["pending", "running"] as const;

/** A request that failed for another reason than its thread or run being
 *  gone already. */
const failed = (result: PromiseSettledResult<unknown>) =>
  result.status === "rejected" && getHttpStatus(result.reason) !== 404;

/** Cancel the thread's pending and running runs; whether every one was
 *  read and cancelled (a thread or run already gone counts as stopped). */
export async function cancelActiveRuns(
  client: RunCancelClient,
  threadId: string
): Promise<boolean> {
  const lists = await Promise.allSettled(
    CANCELABLE_RUN_STATUSES.map((status) =>
      client.runs.list(threadId, { status, limit: 100 })
    )
  );
  const runIds = lists
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map((run) => run.run_id);
  const cancels = await Promise.allSettled(
    runIds.map((runId) => client.runs.cancel(threadId, runId))
  );
  return !lists.some(failed) && !cancels.some(failed);
}
