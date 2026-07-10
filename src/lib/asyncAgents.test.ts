import { describe, expect, it } from "vitest";
import {
  ASYNC_UPDATE_MARKER,
  asyncTaskReportKey,
  asyncUpdateMatchesTask,
  asyncUpdateMessageKey,
  countRunning,
  formatAsyncUpdateMessage,
  formatElapsed,
  isAsyncUpdateMessage,
  isTerminalStatus,
  normalizeAsyncStatus,
  parseAsyncTasks,
  parseAsyncUpdateMessage,
  relTime,
} from "./asyncAgents";

describe("normalizeAsyncStatus", () => {
  it("collapses SDK statuses into the rendered six", () => {
    expect(normalizeAsyncStatus("running")).toBe("running");
    expect(normalizeAsyncStatus("pending")).toBe("running");
    expect(normalizeAsyncStatus("busy")).toBe("running");
    expect(normalizeAsyncStatus("success")).toBe("success");
    expect(normalizeAsyncStatus("error")).toBe("error");
    expect(normalizeAsyncStatus("timeout")).toBe("error");
    expect(normalizeAsyncStatus("cancelled")).toBe("cancelled");
    expect(normalizeAsyncStatus("interrupted")).toBe("cancelled");
    expect(normalizeAsyncStatus("expired")).toBe("expired");
    expect(normalizeAsyncStatus(undefined)).toBe("unknown");
    expect(normalizeAsyncStatus("weird")).toBe("unknown");
  });
});

describe("asyncTaskReportKey", () => {
  it("is unique per (task_id, run_id) pair", () => {
    expect(asyncTaskReportKey({ task_id: "t1", run_id: "r1" })).toBe("t1:r1");
    expect(asyncTaskReportKey({ task_id: "t1", run_id: "r2" })).toBe("t1:r2");
    expect(asyncTaskReportKey({ task_id: "t2", run_id: "r1" })).toBe("t2:r1");
  });

  it("uses 'legacy' when run_id is missing or empty", () => {
    expect(asyncTaskReportKey({ task_id: "t1" })).toBe("t1:legacy");
    expect(asyncTaskReportKey({ task_id: "t1", run_id: "" })).toBe("t1:legacy");
  });
});

describe("formatAsyncUpdateMessage <-> parseAsyncUpdateMessage round-trip", () => {
  it("round-trips task_id and run_id through JSON", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "writing-agent",
      task_id: "task-123",
      run_id: "run-abc",
      status: "success",
    });
    expect(text.startsWith(ASYNC_UPDATE_MARKER + "\n")).toBe(true);
    const parsed = parseAsyncUpdateMessage(text);
    expect(parsed).toEqual({ taskId: "task-123", runId: "run-abc" });
  });

  it("prefers liveStatus over status when present", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "writing-agent",
      task_id: "t",
      run_id: "r",
      status: "running",
      liveStatus: "error",
    });
    // The second line is the JSON payload.
    const payload = JSON.parse(text.split("\n")[1]);
    expect(payload.status).toBe("error");
  });

  it("falls back to 'success' when neither status nor liveStatus is set", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "writing-agent",
      task_id: "t",
      run_id: "r",
      status: "",
    });
    const payload = JSON.parse(text.split("\n")[1]);
    expect(payload.status).toBe("success");
  });

  it("omits run_id from the payload when not provided", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "writing-agent",
      task_id: "t",
      status: "success",
    });
    const payload = JSON.parse(text.split("\n")[1]);
    expect(payload).not.toHaveProperty("run_id");
  });
});

describe("parseAsyncUpdateMessage", () => {
  it("returns null when the marker line is missing", () => {
    expect(parseAsyncUpdateMessage('{"task_id":"t"}')).toBeNull();
  });

  it("returns null when the JSON line is missing", () => {
    expect(parseAsyncUpdateMessage(ASYNC_UPDATE_MARKER)).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(
      parseAsyncUpdateMessage(`${ASYNC_UPDATE_MARKER}\nnot-json`)
    ).toBeNull();
  });

  it("returns null when task_id is missing or empty", () => {
    expect(
      parseAsyncUpdateMessage(`${ASYNC_UPDATE_MARKER}\n{"task_id":""}`)
    ).toBeNull();
    expect(
      parseAsyncUpdateMessage(`${ASYNC_UPDATE_MARKER}\n{"foo":"bar"}`)
    ).toBeNull();
  });

  it("tolerates CRLF line endings", () => {
    const text = `${ASYNC_UPDATE_MARKER}\r\n{"task_id":"t"}`;
    expect(parseAsyncUpdateMessage(text)).toEqual({
      taskId: "t",
      runId: undefined,
    });
  });
});

describe("isAsyncUpdateMessage / asyncUpdateMessageKey", () => {
  it("detects update messages", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "a",
      task_id: "t",
      run_id: "r",
      status: "success",
    });
    expect(isAsyncUpdateMessage(text)).toBe(true);
    expect(isAsyncUpdateMessage("hello world")).toBe(false);
  });

  it("returns the same key as asyncTaskReportKey", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "a",
      task_id: "t",
      run_id: "r",
      status: "success",
    });
    expect(asyncUpdateMessageKey(text)).toBe(
      asyncTaskReportKey({ task_id: "t", run_id: "r" })
    );
    expect(asyncUpdateMessageKey("nope")).toBeNull();
  });
});

describe("asyncUpdateMatchesTask", () => {
  it("matches when task_id and run_id both match", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "a",
      task_id: "t",
      run_id: "r",
      status: "success",
    });
    expect(asyncUpdateMatchesTask(text, { task_id: "t", run_id: "r" })).toBe(
      true
    );
  });

  it("does not match when task_id differs", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "a",
      task_id: "t",
      run_id: "r",
      status: "success",
    });
    expect(
      asyncUpdateMatchesTask(text, { task_id: "other", run_id: "r" })
    ).toBe(false);
  });

  it("matches a legacy (no run_id in payload) message against any run_id", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "a",
      task_id: "t",
      status: "success",
    });
    expect(asyncUpdateMatchesTask(text, { task_id: "t", run_id: "any" })).toBe(
      true
    );
  });

  it("does not match when both messages carry different run_ids", () => {
    const text = formatAsyncUpdateMessage({
      agent_name: "a",
      task_id: "t",
      run_id: "r1",
      status: "success",
    });
    expect(asyncUpdateMatchesTask(text, { task_id: "t", run_id: "r2" })).toBe(
      false
    );
  });
});

describe("parseAsyncTasks", () => {
  it("returns an empty array for non-objects", () => {
    expect(parseAsyncTasks(null)).toEqual([]);
    expect(parseAsyncTasks(undefined)).toEqual([]);
    expect(parseAsyncTasks("string")).toEqual([]);
  });

  it("keeps only records with a task_id and agent_name", () => {
    const out = parseAsyncTasks({
      a: {
        task_id: "t1",
        agent_name: "writing-agent",
        created_at: "2026-01-02T00:00:00Z",
      },
      b: { task_id: "t2" }, // missing agent_name — skipped
      c: null,
      d: { task_id: "t3", agent_name: "data-analysis-agent" },
    });
    expect(out.map((t) => t.task_id)).toEqual(
      expect.arrayContaining(["t1", "t3"])
    );
    expect(out.map((t) => t.task_id)).not.toContain("t2");
  });

  it("sorts newest-first by created_at", () => {
    const out = parseAsyncTasks({
      old: {
        task_id: "old",
        agent_name: "a",
        created_at: "2026-01-01T00:00:00Z",
      },
      new: {
        task_id: "new",
        agent_name: "a",
        created_at: "2026-06-01T00:00:00Z",
      },
    });
    expect(out.map((t) => t.task_id)).toEqual(["new", "old"]);
  });

  it("fills thread_id from task_id when absent", () => {
    const [t] = parseAsyncTasks({
      a: { task_id: "t", agent_name: "a" },
    });
    expect(t.thread_id).toBe("t");
  });
});

describe("isTerminalStatus", () => {
  it("treats success/error/cancelled as terminal", () => {
    expect(isTerminalStatus("success")).toBe(true);
    expect(isTerminalStatus("error")).toBe(true);
    expect(isTerminalStatus("timeout")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("interrupted")).toBe(true);
  });

  it("does NOT treat expired as terminal (auto-report skips those)", () => {
    expect(isTerminalStatus("expired")).toBe(false);
  });

  it("does not treat running/pending as terminal", () => {
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});

describe("countRunning", () => {
  it("counts tasks that normalize to 'running'", () => {
    const tasks = [
      { liveStatus: "running", status: "success" },
      { liveStatus: "pending", status: "" },
      { liveStatus: undefined, status: "busy" },
      { liveStatus: "success", status: "running" },
    ];
    expect(countRunning(tasks)).toBe(3);
  });

  it("prefers liveStatus over status", () => {
    expect(countRunning([{ liveStatus: "success", status: "running" }])).toBe(
      0
    );
  });
});

describe("formatElapsed", () => {
  it("returns '' when startIso is missing or unparseable", () => {
    expect(formatElapsed(undefined, Date.now())).toBe("");
    expect(formatElapsed("not-a-date", Date.now())).toBe("");
  });

  it("formats seconds when under a minute", () => {
    const start = "2026-01-01T00:00:00Z";
    const end = Date.parse(start) + 45_000;
    expect(formatElapsed(start, end)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    const start = "2026-01-01T00:00:00Z";
    const end = Date.parse(start) + (2 * 60 + 5) * 1000;
    expect(formatElapsed(start, end)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    const start = "2026-01-01T00:00:00Z";
    const end = Date.parse(start) + (2 * 60 + 15) * 60 * 1000;
    expect(formatElapsed(start, end)).toBe("2h 15m");
  });

  it("clamps negative durations to 0s", () => {
    const start = "2026-01-01T00:00:00Z";
    expect(formatElapsed(start, Date.parse(start) - 1000)).toBe("0s");
  });
});

describe("relTime", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");

  it("returns '' when input is missing or unparseable", () => {
    expect(relTime(undefined, now)).toBe("");
    expect(relTime("nope", now)).toBe("");
  });

  it("uses seconds under a minute", () => {
    expect(relTime(new Date(now - 30_000).toISOString(), now)).toBe("30s");
  });

  it("uses minutes under an hour", () => {
    expect(relTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
  });

  it("uses hours under a day", () => {
    expect(relTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe("3h");
  });

  it("uses days beyond that", () => {
    expect(relTime(new Date(now - 2 * 86400_000).toISOString(), now)).toBe(
      "2d"
    );
  });
});
