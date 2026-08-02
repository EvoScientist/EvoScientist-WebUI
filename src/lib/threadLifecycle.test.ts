import { describe, expect, it, vi } from "vitest";
import { cancelActiveRuns } from "@/lib/threadLifecycle";

function fakeClient(byStatus: Record<string, Array<{ run_id: string }>>) {
  return {
    runs: {
      list: vi.fn(
        async (_threadId: string, options?: { status?: string }) =>
          byStatus[options?.status ?? ""] ?? []
      ),
      cancel: vi.fn(async () => {}),
    },
  };
}

describe("cancelActiveRuns", () => {
  it("cancels every pending and running run", async () => {
    const client = fakeClient({
      pending: [{ run_id: "r1" }],
      running: [{ run_id: "r2" }, { run_id: "r3" }],
    });
    await cancelActiveRuns(client, "t1");
    expect(client.runs.cancel).toHaveBeenCalledTimes(3);
    expect(client.runs.cancel).toHaveBeenCalledWith("t1", "r2");
  });

  it("does nothing when there are no active runs", async () => {
    const client = fakeClient({});
    await cancelActiveRuns(client, "t1");
    expect(client.runs.cancel).not.toHaveBeenCalled();
  });

  it("swallows cancel failures", async () => {
    const client = fakeClient({ running: [{ run_id: "r1" }] });
    client.runs.cancel.mockRejectedValueOnce(new Error("gone"));
    await expect(cancelActiveRuns(client, "t1")).resolves.toBeUndefined();
  });
});
