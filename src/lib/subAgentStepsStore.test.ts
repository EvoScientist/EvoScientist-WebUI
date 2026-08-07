// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAgentStep } from "./subAgentActivity";
import {
  loadThreadSubAgentSteps,
  saveThreadSubAgentSteps,
} from "./subAgentStepsStore";

const STORAGE_KEY = "evoscientist-subagent-steps-v2";
const LEGACY_STORAGE_KEY = "evoscientist-subagent-steps";

const steps: SubAgentStep[] = [
  { kind: "tool_call", id: "tc1", name: "execute", args: { command: "ls" } },
  { kind: "tool_result", toolCallId: "tc1", name: "execute", text: "a b c" },
  { kind: "text", text: "done" },
];

beforeEach(() => {
  localStorage.clear();
});

describe("subAgentStepsStore", () => {
  it("round-trips a thread's task steps in a versioned envelope", () => {
    saveThreadSubAgentSteps("t1", { task_a: steps });
    expect(loadThreadSubAgentSteps("t1")).toEqual({ task_a: steps });
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null").version
    ).toBe(1);
  });

  it("migrates the unversioned Claude Code store", () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ t1: { updatedAt: 1, tasks: { task_a: steps } } })
    );
    expect(loadThreadSubAgentSteps("t1")).toEqual({ task_a: steps });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("caps steps and long text fields", () => {
    const many: SubAgentStep[] = Array.from({ length: 250 }, (_, index) => ({
      kind: "text",
      text: `${index}:${"x".repeat(11_000)}`,
    }));
    saveThreadSubAgentSteps("t1", { task_a: many });
    const stored = loadThreadSubAgentSteps("t1").task_a;
    expect(stored).toHaveLength(200);
    expect((stored[0] as { text: string }).text.startsWith("50:")).toBe(true);
    expect((stored[0] as { text: string }).text.endsWith("…[truncated]")).toBe(
      true
    );
  });

  it("caps long strings nested inside tool-call args", () => {
    const long = "y".repeat(12_000);
    saveThreadSubAgentSteps("t1", {
      task_a: [
        {
          kind: "tool_call",
          id: "tc",
          name: "write_file",
          args: {
            files: [{ path: "/a.txt", content: long }],
            meta: { inner: { note: long } },
          },
        },
      ],
    });
    const stored = loadThreadSubAgentSteps("t1").task_a;
    const args = (stored[0] as { args: Record<string, unknown> }).args;
    const files = args.files as Array<{ path: string; content: string }>;
    expect(files[0].path).toBe("/a.txt");
    expect(files[0].content.length).toBeLessThan(5_100);
    expect(files[0].content.endsWith("…[truncated]")).toBe(true);
    const meta = args.meta as { inner: { note: string } };
    expect(meta.inner.note.endsWith("…[truncated]")).toBe(true);
  });

  it("replaces branches beyond the arg depth limit", () => {
    let deep: Record<string, unknown> = { leaf: "depth-sentinel" };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    saveThreadSubAgentSteps("t1", {
      task_a: [{ kind: "tool_call", id: "tc", name: "n", args: deep }],
    });
    const stored = loadThreadSubAgentSteps("t1").task_a;
    expect(JSON.stringify(stored)).not.toContain("depth-sentinel");
  });

  it("evicts the least recently updated thread beyond 20", () => {
    for (let index = 0; index < 21; index++) {
      saveThreadSubAgentSteps(`t${index}`, { task: steps });
    }
    expect(loadThreadSubAgentSteps("t0")).toEqual({});
    expect(loadThreadSubAgentSteps("t20")).toEqual({ task: steps });
  });

  it("drops malformed task entries", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        threads: {
          t1: {
            updatedAt: 1,
            tasks: { good: steps, bad: [{ kind: "tool_call" }] },
          },
        },
      })
    );
    expect(loadThreadSubAgentSteps("t1")).toEqual({ good: steps });
  });

  it("degrades safely when browser storage access is blocked", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    expect(loadThreadSubAgentSteps("t1")).toEqual({});
    getItem.mockRestore();
  });
});
