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

export async function cancelActiveRuns(
  client: RunCancelClient,
  threadId: string
): Promise<void> {
  const lists = await Promise.allSettled(
    CANCELABLE_RUN_STATUSES.map((status) =>
      client.runs.list(threadId, { status, limit: 100 })
    )
  );
  const runIds = lists
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map((run) => run.run_id);
  await Promise.allSettled(
    runIds.map((runId) => client.runs.cancel(threadId, runId))
  );
}
