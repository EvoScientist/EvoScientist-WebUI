import { describe, expect, it } from "vitest";
import { pickThreadMessages } from "./threadMessages";

const msg = (id: string, type = "ai") => ({ id, type, content: id });

describe("pickThreadMessages", () => {
  it("returns null when both sources are missing", () => {
    expect(pickThreadMessages(undefined, undefined)).toBeNull();
    expect(pickThreadMessages(null, null)).toBeNull();
    expect(pickThreadMessages("junk", 42)).toBeNull();
  });

  // `/state` is always the root conversation; the bare record is the latest
  // checkpoint of any namespace. While a goal's review waits, that is the
  // goal drafter's run, with the root conversation still empty.
  it("keeps an empty root conversation over another namespace's record", () => {
    const record = [msg("drafter-prompt", "human"), msg("drafter-reply")];
    expect(pickThreadMessages([], record)).toEqual([]);
    expect(pickThreadMessages([], [])).toEqual([]);
  });

  it("trusts no record without the root conversation", () => {
    const record = [msg("drafter-prompt", "human"), msg("drafter-reply")];
    expect(pickThreadMessages(undefined, record)).toBeNull();
  });

  it("returns state when the record is empty or missing", () => {
    const state = [msg("a")];
    expect(pickThreadMessages(state, undefined)).toEqual(state);
    expect(pickThreadMessages(state, [])).toEqual(state);
  });

  it("prefers the record when it contains state's first message (full history superset)", () => {
    const state = [msg("m3"), msg("m4")];
    const record = [msg("m1"), msg("m2"), msg("m3"), msg("m4")];
    expect(pickThreadMessages(state, record)).toEqual(record);
  });

  it("falls back to state when the record is from a different namespace (sub-agent slice)", () => {
    const state = [msg("root-1", "human"), msg("root-2")];
    const record = [msg("subagent-prompt", "human")];
    expect(pickThreadMessages(state, record)).toEqual(state);
  });

  it("falls back to state even when the foreign record is longer", () => {
    const state = [msg("root-1", "human"), msg("root-2")];
    const record = [
      msg("sub-prompt", "human"),
      msg("sub-ai"),
      msg("sub-tool", "tool"),
      msg("sub-ai-2"),
    ];
    expect(pickThreadMessages(state, record)).toEqual(state);
  });

  it("prefers the record when state's first message has no id", () => {
    const state = [{ type: "human", content: "x" }, msg("m2")];
    const record = [msg("m1"), msg("m2")];
    expect(pickThreadMessages(state, record)).toEqual(record);
  });
});
