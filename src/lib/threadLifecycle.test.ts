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

  it("reports a cancel that failed", async () => {
    const client = fakeClient({ running: [{ run_id: "r1" }] });
    client.runs.cancel.mockRejectedValueOnce(new Error("boom"));
    await expect(cancelActiveRuns(client, "t1")).resolves.toBe(false);
  });

  it("counts a run already gone as stopped", async () => {
    const client = fakeClient({ running: [{ run_id: "r1" }] });
    client.runs.cancel.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 404"), { status: 404 })
    );
    await expect(cancelActiveRuns(client, "t1")).resolves.toBe(true);
  });

  it("reports runs it couldn't read as not stopped", async () => {
    const client = fakeClient({});
    client.runs.list.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 500"), { status: 500 })
    );
    await expect(cancelActiveRuns(client, "t1")).resolves.toBe(false);
  });

  it("counts a thread already gone as stopped", async () => {
    const client = fakeClient({});
    client.runs.list.mockRejectedValue(
      Object.assign(new Error("HTTP 404"), { status: 404 })
    );
    await expect(cancelActiveRuns(client, "t1")).resolves.toBe(true);
  });
});
