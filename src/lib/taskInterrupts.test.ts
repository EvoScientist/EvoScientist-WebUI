import { describe, expect, it } from "vitest";
import { latestTaskInterrupt } from "@/app/hooks/useChat";

const interrupt = (id: string, command: string) => ({
  id,
  value: {
    action_requests: [{ name: "execute", args: { command } }],
    review_configs: [{ action_name: "execute" }],
  },
});

describe("latestTaskInterrupt", () => {
  it("returns undefined for missing or empty tasks", () => {
    expect(latestTaskInterrupt(undefined)).toBeUndefined();
    expect(latestTaskInterrupt([])).toBeUndefined();
  });

  it("returns the last pending task's last interrupt", () => {
    const a = interrupt("aaa", "python3 /hello_en.py");
    const b = interrupt("bbb", "python3 /hello_zh.py");
    expect(
      latestTaskInterrupt([
        { interrupts: [a], error: null, result: null },
        { interrupts: [b], error: null, result: null },
      ])
    ).toBe(b);
  });

  it("skips a task whose interrupt was already resolved (result set) — parallel sub-agent drain", () => {
    const pending = interrupt("366a3fce", "python3 /hello_en.py");
    const resolved = interrupt("13ca4ee6", "python3 /hello_zh.py");
    expect(
      latestTaskInterrupt([
        { interrupts: [pending], error: null, result: null },
        {
          interrupts: [resolved],
          error: null,
          result: { messages: [{ type: "tool", content: "done" }] },
        },
      ])
    ).toBe(pending);
  });

  it("skips a task that errored", () => {
    const pending = interrupt("aaa", "ls");
    const failed = interrupt("bbb", "pwd");
    expect(
      latestTaskInterrupt([
        { interrupts: [pending], error: null, result: null },
        { interrupts: [failed], error: "Boom", result: null },
      ])
    ).toBe(pending);
  });

  it("returns undefined when every interrupt-bearing task has completed", () => {
    expect(
      latestTaskInterrupt([
        { interrupts: [interrupt("aaa", "ls")], error: null, result: {} },
      ])
    ).toBeUndefined();
  });

  it("tolerates tasks without result/error fields", () => {
    const a = interrupt("aaa", "ls");
    expect(latestTaskInterrupt([{ interrupts: [a] }])).toBe(a);
  });
});
