import { describe, expect, it } from "vitest";
import {
  computeToolCount,
  computeTokenTotals,
  formatTokenCount,
  lastUpdatedAt,
} from "./personaMetrics";

describe("computeToolCount", () => {
  it("counts every tool_calls entry across AI messages", () => {
    const messages = [
      { type: "ai", tool_calls: [{ id: "1", name: "read_file" }] },
      { type: "tool", tool_call_id: "1", content: "ok" },
      {
        type: "ai",
        tool_calls: [
          { id: "2", name: "write_file" },
          { id: "3", name: "execute" },
        ],
      },
    ];
    expect(computeToolCount(messages)).toBe(3);
  });

  it("falls back to additional_kwargs.tool_calls (OpenAI shape)", () => {
    const messages = [
      {
        type: "ai",
        additional_kwargs: {
          tool_calls: [{ id: "1" }, { id: "2" }],
        },
      },
    ];
    expect(computeToolCount(messages)).toBe(2);
  });

  it("prefers top-level tool_calls when both are present", () => {
    const messages = [
      {
        type: "ai",
        tool_calls: [{ id: "1", name: "read_file" }],
        additional_kwargs: {
          tool_calls: [{ id: "2" }, { id: "3" }],
        },
      },
    ];
    expect(computeToolCount(messages)).toBe(1);
  });

  it("ignores non-AI messages entirely", () => {
    const messages = [
      { type: "human", content: "hi" },
      { type: "tool", tool_call_id: "1", content: "ok" },
      { type: "system", content: "you are…" },
    ];
    expect(computeToolCount(messages)).toBe(0);
  });

  it("returns 0 on an empty array", () => {
    expect(computeToolCount([])).toBe(0);
  });
});

describe("computeTokenTotals", () => {
  it("sums usage_metadata across AI messages", () => {
    const messages = [
      {
        type: "ai",
        usage_metadata: { input_tokens: 100, output_tokens: 25 },
      },
      { type: "tool", tool_call_id: "1", content: "ok" },
      {
        type: "ai",
        usage_metadata: { input_tokens: 500, output_tokens: 40 },
      },
    ];
    expect(computeTokenTotals(messages)).toEqual({ input: 600, output: 65 });
  });

  it("skips AI messages with no usage_metadata", () => {
    const messages = [
      { type: "ai", content: "hello" },
      {
        type: "ai",
        usage_metadata: { input_tokens: 10, output_tokens: 2 },
      },
    ];
    expect(computeTokenTotals(messages)).toEqual({ input: 10, output: 2 });
  });

  it("returns zeros on empty input", () => {
    expect(computeTokenTotals([])).toEqual({ input: 0, output: 0 });
  });
});

describe("formatTokenCount", () => {
  it("formats sub-1000 as plain integer", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(987)).toBe("987");
  });

  it("formats 1k+ with one decimal, trimming trailing .0", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(7200)).toBe("7.2k");
    expect(formatTokenCount(394600)).toBe("394.6k");
    expect(formatTokenCount(5000)).toBe("5k");
  });

  it("guards against negatives and non-finite input", () => {
    expect(formatTokenCount(-1)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("lastUpdatedAt", () => {
  it("picks the newest timestamp across updated_at / created_at", () => {
    const messages = [
      { type: "ai", created_at: "2026-07-30T10:00:00Z" },
      { type: "ai", updated_at: "2026-07-30T12:00:00Z" },
      { type: "tool", created_at: "2026-07-30T11:00:00Z" },
    ];
    expect(lastUpdatedAt(messages)).toBe("2026-07-30T12:00:00Z");
  });

  it("falls through to additional_kwargs.updated_at", () => {
    const messages = [
      {
        type: "ai",
        additional_kwargs: { updated_at: "2026-07-30T09:00:00Z" },
      },
    ];
    expect(lastUpdatedAt(messages)).toBe("2026-07-30T09:00:00Z");
  });

  it("returns null when no message carries a resolvable timestamp", () => {
    expect(lastUpdatedAt([{ type: "ai", content: "hi" }])).toBeNull();
    expect(lastUpdatedAt([])).toBeNull();
  });

  it("ignores unparseable timestamp strings", () => {
    const messages = [
      { type: "ai", created_at: "not-a-date" },
      { type: "ai", created_at: "2026-07-30T09:00:00Z" },
    ];
    expect(lastUpdatedAt(messages)).toBe("2026-07-30T09:00:00Z");
  });
});
