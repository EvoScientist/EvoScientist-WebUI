// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAbandonedInterruptKey,
  clearAbandonedInterrupts,
  getAbandonedInterruptKeys,
} from "./abandonedInterrupts";

describe("abandonedInterrupts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty set for a thread with no entry (or a null thread)", () => {
    expect(getAbandonedInterruptKeys("t1").size).toBe(0);
    expect(getAbandonedInterruptKeys(null).size).toBe(0);
    expect(getAbandonedInterruptKeys(undefined).size).toBe(0);
  });

  it("persists a key per thread and reads it back", () => {
    addAbandonedInterruptKey("t1", "id:abc");
    expect(getAbandonedInterruptKeys("t1")).toEqual(new Set(["id:abc"]));
    // Other threads are unaffected.
    expect(getAbandonedInterruptKeys("t2").size).toBe(0);
  });

  it("accumulates multiple distinct keys and dedupes repeats", () => {
    addAbandonedInterruptKey("t1", "id:a");
    addAbandonedInterruptKey("t1", "id:b");
    addAbandonedInterruptKey("t1", "id:a");
    expect(getAbandonedInterruptKeys("t1")).toEqual(new Set(["id:a", "id:b"]));
  });

  it("ignores empty keys and null/undefined thread ids", () => {
    addAbandonedInterruptKey("t1", "");
    addAbandonedInterruptKey("t1", null);
    addAbandonedInterruptKey(null, "id:a");
    addAbandonedInterruptKey(undefined, "id:a");
    expect(getAbandonedInterruptKeys("t1").size).toBe(0);
  });

  it("clears a thread's keys without touching others", () => {
    addAbandonedInterruptKey("t1", "id:a");
    addAbandonedInterruptKey("t2", "id:b");
    clearAbandonedInterrupts("t1");
    expect(getAbandonedInterruptKeys("t1").size).toBe(0);
    expect(getAbandonedInterruptKeys("t2")).toEqual(new Set(["id:b"]));
  });

  it("treats corrupt storage as empty", () => {
    localStorage.setItem("evoscientist-abandoned-interrupts", "{not json");
    expect(getAbandonedInterruptKeys("t1").size).toBe(0);
  });
});
