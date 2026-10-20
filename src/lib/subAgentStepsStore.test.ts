// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubAgentStep } from "./subAgentActivity";
import {
  clearSubAgentStepsCache,
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

  // Reading never writes: the next save moves the old map, fitted.
  it("reads the unversioned Claude Code store until a save moves it", () => {
    const old = JSON.stringify({
      t1: { updatedAt: 1, tasks: { task_a: steps } },
    });
    localStorage.setItem(LEGACY_STORAGE_KEY, old);
    expect(loadThreadSubAgentSteps("t1")).toEqual({ task_a: steps });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBe(old);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    saveThreadSubAgentSteps("t2", { task_b: steps });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(loadThreadSubAgentSteps("t1")).toEqual({ task_a: steps });
    expect(loadThreadSubAgentSteps("t2")).toEqual({ task_b: steps });
  });

  // A save under the new key leaves no use for an old copy left behind.
  it("removes an old copy left beside the new store", () => {
    saveThreadSubAgentSteps("t1", { task_a: steps });
    localStorage.setItem(LEGACY_STORAGE_KEY, "{}");
    saveThreadSubAgentSteps("t1", { task_a: steps });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("keeps a task's latest 200 steps", () => {
    const many: SubAgentStep[] = Array.from({ length: 250 }, (_, index) => ({
      kind: "text",
      text: `${index}:x`,
    }));
    saveThreadSubAgentSteps("t1", { task_a: many });
    const stored = loadThreadSubAgentSteps("t1").task_a;
    expect(stored).toHaveLength(200);
    expect(stored[0]).toEqual({ kind: "text", text: "50:x" });
  });

  it("caps long text fields", () => {
    saveThreadSubAgentSteps("t1", {
      task_a: [{ kind: "text", text: "x".repeat(11_000) }],
    });
    const [step] = loadThreadSubAgentSteps("t1").task_a;
    expect(step).toEqual({
      kind: "text",
      text: "x".repeat(10_000) + "…[truncated]",
    });
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

  it("keeps a failed step's mark across a reload", () => {
    const failed: SubAgentStep[] = [
      {
        kind: "tool_call",
        id: "tc1",
        name: "edit_file",
        args: { old_string: "a", new_string: "b" },
      },
      {
        kind: "tool_result",
        toolCallId: "tc1",
        name: "edit_file",
        text: "Error: String not found",
        failed: true,
      },
    ];
    saveThreadSubAgentSteps("t1", { task_a: failed });
    expect(loadThreadSubAgentSteps("t1")).toEqual({ task_a: failed });
  });

  it("drops a task whose stored failure mark isn't true", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        threads: {
          t1: {
            updatedAt: 1,
            tasks: {
              good: steps,
              bad: [
                {
                  kind: "tool_result",
                  toolCallId: "tc1",
                  name: "execute",
                  text: "x",
                  failed: "yes",
                },
              ],
            },
          },
        },
      })
    );
    expect(loadThreadSubAgentSteps("t1")).toEqual({ good: steps });
  });

  it("keeps a reasoning step through a reload", () => {
    const reasoning: SubAgentStep[] = [
      { kind: "reasoning", text: "**Plan**", markdown: true },
      { kind: "text", text: "done" },
    ];
    saveThreadSubAgentSteps("t1", { task_a: reasoning });
    expect(loadThreadSubAgentSteps("t1")).toEqual({ task_a: reasoning });
  });

  it("caps long reasoning like text", () => {
    saveThreadSubAgentSteps("t1", {
      task_a: [
        { kind: "reasoning", text: "r".repeat(12_000), markdown: false },
      ],
    });
    const [step] = loadThreadSubAgentSteps("t1").task_a;
    expect(step).toEqual({
      kind: "reasoning",
      text: "r".repeat(10_000) + "…[truncated]",
      markdown: false,
    });
  });

  it.each([
    ["no Markdown flag", { kind: "reasoning", text: "x" }],
    ["text that isn't text", { kind: "reasoning", text: 5, markdown: false }],
  ])("drops a task whose reasoning step has %s", (_label, step) => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        threads: { t1: { updatedAt: 1, tasks: { task_a: [step] } } },
      })
    );
    expect(loadThreadSubAgentSteps("t1")).toEqual({});
  });

  describe("size budget", () => {
    const BUDGET = 1_000_000;
    // `count` text steps of 10,000 characters each, the cap for one step.
    const bigTask = (count: number): SubAgentStep[] =>
      Array.from({ length: count }, () => ({
        kind: "text",
        text: "x".repeat(10_000),
      }));
    const storedLength = () => (localStorage.getItem(STORAGE_KEY) ?? "").length;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("drops the least recently updated threads to stay under the budget", () => {
      vi.useFakeTimers();
      ["t1", "t2", "t3", "t4"].forEach((id, index) => {
        vi.setSystemTime(1_000 + index);
        saveThreadSubAgentSteps(id, { task: bigTask(30) });
      });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("t1")).toEqual({});
      for (const id of ["t2", "t3", "t4"]) {
        expect(loadThreadSubAgentSteps(id).task).toHaveLength(30);
      }
      // A thread left without tasks isn't kept as an empty entry.
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(Object.keys(stored.threads)).toEqual(["t2", "t3", "t4"]);
    });

    // The length is counted, not estimated: an old thread's first task goes,
    // and its second stays only if the store is then within the budget.
    it.each([
      ["at", 0, ["y"]],
      ["one character over", 1, []],
    ])(
      "stops at the budget when the first removal leaves it %s",
      (_label, over, oldTasks) => {
        vi.useFakeTimers();
        const small: SubAgentStep = { kind: "text", text: "s" };
        const full: SubAgentStep = { kind: "text", text: "p".repeat(10_000) };
        const pad = (rest: number): SubAgentStep[] => [
          ...Array.from({ length: 99 }, () => full),
          { kind: "text", text: "p".repeat(rest) },
        ];
        const envelope = (rest: number) => ({
          version: 1,
          threads: {
            old: { updatedAt: 1_000, tasks: { x: [small], y: pad(rest) } },
            cur: { updatedAt: 2_000, tasks: { z: [small] } },
          },
        });
        // Removing x takes its key, colon, value and the comma before y.
        const removed =
          JSON.stringify("x").length + 1 + JSON.stringify([small]).length + 1;
        const rest =
          BUDGET + over + removed - JSON.stringify(envelope(0)).length;

        vi.setSystemTime(1_000);
        saveThreadSubAgentSteps("old", { x: [small], y: pad(rest) });
        vi.setSystemTime(2_000);
        saveThreadSubAgentSteps("cur", { z: [small] });

        expect(storedLength()).toBeLessThanOrEqual(BUDGET);
        expect(Object.keys(loadThreadSubAgentSteps("old"))).toEqual(oldTasks);
        expect(loadThreadSubAgentSteps("cur")).toEqual({ z: [small] });
      }
    );

    it("drops an over-budget thread's oldest tasks once it is alone", () => {
      saveThreadSubAgentSteps("t1", {
        a: bigTask(40),
        b: bigTask(40),
        c: bigTask(40),
      });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(Object.keys(loadThreadSubAgentSteps("t1"))).toEqual(["b", "c"]);
    });

    // As the step cap does, the latest steps are the ones worth keeping.
    it("keeps the latest steps of a task that alone is over it", () => {
      const numbered: SubAgentStep[] = Array.from(
        { length: 120 },
        (_, index) => ({ kind: "text", text: `${index}:${"x".repeat(9_990)}` })
      );
      saveThreadSubAgentSteps("t1", { a: numbered });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(storedLength()).toBeGreaterThan(BUDGET - 11_000);
      const kept = loadThreadSubAgentSteps("t1").a;
      expect(kept.length).toBeLessThan(120);
      expect(kept.at(-1)).toEqual(numbered[119]);
      expect(kept[0]).toEqual(numbered[120 - kept.length]);
      // Exactly as many as fit: one more step would go over.
      const next = numbered[120 - kept.length - 1];
      expect(storedLength() + JSON.stringify(next).length + 1).toBeGreaterThan(
        BUDGET
      );
    });

    // A thread's last task has no comma after it.
    it("counts an emptied thread exactly", () => {
      vi.useFakeTimers();
      const small: SubAgentStep = { kind: "text", text: "s" };
      const full: SubAgentStep = { kind: "text", text: "p".repeat(10_000) };
      const pad = (rest: number): SubAgentStep[] => [
        ...Array.from({ length: 99 }, () => full),
        { kind: "text", text: "p".repeat(rest) },
      ];
      const envelope = (rest: number) => ({
        version: 1,
        threads: {
          old1: { updatedAt: 1_000, tasks: { x: [small] } },
          old2: { updatedAt: 2_000, tasks: { w: [small] } },
          cur: { updatedAt: 3_000, tasks: { z: pad(rest) } },
        },
      });
      // x is old1's only task, then the emptied thread goes with its comma.
      const removed =
        JSON.stringify("x").length +
        1 +
        JSON.stringify([small]).length +
        JSON.stringify("old1").length +
        1 +
        JSON.stringify({ updatedAt: 1_000, tasks: {} }).length +
        1;
      // One character over the budget once old1 is gone, so old2 goes too.
      const rest = BUDGET + 1 + removed - JSON.stringify(envelope(0)).length;

      vi.setSystemTime(1_000);
      saveThreadSubAgentSteps("old1", { x: [small] });
      vi.setSystemTime(2_000);
      saveThreadSubAgentSteps("old2", { w: [small] });
      vi.setSystemTime(3_000);
      saveThreadSubAgentSteps("cur", { z: pad(rest) });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("old1")).toEqual({});
      expect(loadThreadSubAgentSteps("old2")).toEqual({});
      expect(loadThreadSubAgentSteps("cur").z).toHaveLength(100);
    });

    // Another tab's clock can run ahead; the current thread still stays.
    it("never evicts the current thread for another one, whatever their times", () => {
      vi.useFakeTimers();
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          threads: {
            ahead: { updatedAt: 9_000_000, tasks: { task: bigTask(60) } },
          },
        })
      );
      vi.setSystemTime(1_000);
      saveThreadSubAgentSteps("cur", { task: bigTask(60) });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("cur").task).toHaveLength(60);
      expect(loadThreadSubAgentSteps("ahead")).toEqual({});
    });

    // A finished task ends with text, so a huge call sits before its end.
    it("trims the current thread before evicting the others", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      saveThreadSubAgentSteps("a", { task: bigTask(30) });
      vi.setSystemTime(2_000);
      saveThreadSubAgentSteps("b", { task: bigTask(30) });
      const args = Object.fromEntries(
        Array.from({ length: 210 }, (_, index) => [
          `k${index}`,
          "a".repeat(5_000),
        ])
      );
      const result: SubAgentStep = {
        kind: "tool_result",
        toolCallId: "c1",
        name: "write",
        text: "ok",
      };
      const done: SubAgentStep = { kind: "text", text: "Written." };
      vi.setSystemTime(3_000);
      saveThreadSubAgentSteps("big", {
        task: [
          { kind: "tool_call", id: "c1", name: "write", args },
          result,
          done,
        ],
      });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("big")).toEqual({ task: [result, done] });
      expect(loadThreadSubAgentSteps("a").task).toHaveLength(30);
      expect(loadThreadSubAgentSteps("b").task).toHaveLength(30);
    });

    it("drops the oldest tasks of the least recently updated thread first", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      saveThreadSubAgentSteps("old", { a: bigTask(30), b: bigTask(30) });
      vi.setSystemTime(2_000);
      saveThreadSubAgentSteps("current", { c: bigTask(30), d: bigTask(20) });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(Object.keys(loadThreadSubAgentSteps("old"))).toEqual(["b"]);
      expect(Object.keys(loadThreadSubAgentSteps("current"))).toEqual([
        "c",
        "d",
      ]);
    });

    // A tool call's args cap each string, not how many there are. Evicting
    // other threads wouldn't make room for it, so they stay.
    it("keeps no thread whose last step alone is over it, and the others", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      saveThreadSubAgentSteps("t0", { task: steps });
      const args = Object.fromEntries(
        Array.from({ length: 210 }, (_, index) => [
          `k${index}`,
          "a".repeat(5_000),
        ])
      );
      vi.setSystemTime(2_000);
      saveThreadSubAgentSteps("t1", {
        small: steps,
        a: [{ kind: "tool_call", id: "c1", name: "write", args }],
      });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("t1")).toEqual({});
      expect(loadThreadSubAgentSteps("t0")).toEqual({ task: steps });
    });

    // Found in a stored entry, a task list that isn't a map can't be counted.
    it("drops a stored thread whose tasks aren't a map", () => {
      vi.useFakeTimers();
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          threads: {
            odd: { updatedAt: 1, tasks: [bigTask(30), bigTask(30)] },
          },
        })
      );
      vi.setSystemTime(2_000);
      saveThreadSubAgentSteps("cur", { task: bigTask(45) });

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(Object.keys(stored.threads)).toEqual(["cur"]);
    });

    // A store written before the budget can be over it.
    it("fits the store when a thread's steps are removed", () => {
      vi.useFakeTimers();
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          threads: {
            a: { updatedAt: 1, tasks: { task: bigTask(60) } },
            b: { updatedAt: 2, tasks: { task: bigTask(60) } },
            c: { updatedAt: 3, tasks: { task: steps } },
          },
        })
      );
      saveThreadSubAgentSteps("c", {});

      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("a")).toEqual({});
      expect(loadThreadSubAgentSteps("b").task).toHaveLength(60);
      expect(loadThreadSubAgentSteps("c")).toEqual({});
    });

    const legacyThreads = () =>
      Object.fromEntries(
        ["t1", "t2", "t3", "t4"].map((id, index) => [
          id,
          { updatedAt: index + 1, tasks: { task: bigTask(30) } },
        ])
      );

    // The thread being opened can be the oldest, so reading takes nothing.
    it("moves the old store into the budget at the next save", () => {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacyThreads()));

      const opened = loadThreadSubAgentSteps("t1");
      expect(opened.task).toHaveLength(30);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      saveThreadSubAgentSteps("t1", opened);
      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
      expect(loadThreadSubAgentSteps("t1").task).toHaveLength(30);
      expect(loadThreadSubAgentSteps("t2")).toEqual({});
    });

    it("keeps the whole old store when a save can't be written", () => {
      const old = JSON.stringify(legacyThreads());
      const items = new Map([[LEGACY_STORAGE_KEY, old]]);
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: () => {
          throw new DOMException(
            "The quota was exceeded.",
            "QuotaExceededError"
          );
        },
        removeItem: (key: string) => items.delete(key),
      });
      try {
        saveThreadSubAgentSteps("t4", { task: steps });
        expect(items.get(LEGACY_STORAGE_KEY)).toBe(old);
        expect(loadThreadSubAgentSteps("t1").task).toHaveLength(30);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // A thread id is never empty, but a damaged store can hold one.
    it("fits a store holding a thread with an empty id", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          threads: {
            "": { updatedAt: 0, tasks: {} },
            a: { updatedAt: 1, tasks: { task: bigTask(60) } },
            b: { updatedAt: 2, tasks: { task: bigTask(60) } },
            c: { updatedAt: 3, tasks: { task: steps } },
          },
        })
      );
      expect(() => saveThreadSubAgentSteps("c", {})).not.toThrow();
      expect(storedLength()).toBeLessThanOrEqual(BUDGET);
      expect(loadThreadSubAgentSteps("b").task).toHaveLength(60);
    });
  });

  it("clears the cache and its legacy key", () => {
    saveThreadSubAgentSteps("t1", { task_a: steps });
    localStorage.setItem(LEGACY_STORAGE_KEY, "{}");
    clearSubAgentStepsCache();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  // A prototype spy never runs on Node 25's storage, so the global is swapped.
  it("degrades safely when browser storage access is blocked", () => {
    const getItem = vi.fn(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.stubGlobal("localStorage", { getItem });
    try {
      expect(loadThreadSubAgentSteps("t1")).toEqual({});
      expect(getItem).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
