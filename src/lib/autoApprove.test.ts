// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getThreadAutoApprove,
  migrateNewThreadAutoApprove,
  setThreadAutoApprove,
} from "./autoApprove";

const STORAGE_KEY = "evoscientist-auto-approve";
const NEW_THREAD_KEY = "__new__";

function readStorage(): Record<string, boolean> {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
}

describe("autoApprove", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns false for a thread with no entry", () => {
    expect(getThreadAutoApprove("t1")).toBe(false);
    expect(getThreadAutoApprove(null)).toBe(false);
  });

  it("persists a per-thread on value and reads it back", () => {
    setThreadAutoApprove("t1", true);
    expect(getThreadAutoApprove("t1")).toBe(true);
    // Other threads unaffected.
    expect(getThreadAutoApprove("t2")).toBe(false);
  });

  it("uses the sentinel key for the pending new chat", () => {
    setThreadAutoApprove(null, true);
    expect(getThreadAutoApprove(null)).toBe(true);
    expect(readStorage()).toEqual({ [NEW_THREAD_KEY]: true });
  });

  it("turning off removes the entry rather than storing false", () => {
    setThreadAutoApprove("t1", true);
    setThreadAutoApprove("t1", false);
    expect(getThreadAutoApprove("t1")).toBe(false);
    expect(readStorage()).toEqual({});
  });

  it("recovers from corrupt localStorage payloads", () => {
    localStorage.setItem(STORAGE_KEY, "not json");
    expect(getThreadAutoApprove("t1")).toBe(false);
    // Writing after corruption should succeed and leave a clean map.
    setThreadAutoApprove("t1", true);
    expect(readStorage()).toEqual({ t1: true });
  });

  it("ignores an array (non-object) payload", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(getThreadAutoApprove("t1")).toBe(false);
  });

  it("migrates a sentinel setting onto a real thread id", () => {
    setThreadAutoApprove(null, true);
    migrateNewThreadAutoApprove("real-tid");
    expect(getThreadAutoApprove("real-tid")).toBe(true);
    expect(getThreadAutoApprove(null)).toBe(false);
    expect(readStorage()).toEqual({ "real-tid": true });
  });

  it("migrate is a no-op when the sentinel was never enabled", () => {
    setThreadAutoApprove("existing", true);
    migrateNewThreadAutoApprove("real-tid");
    expect(getThreadAutoApprove("real-tid")).toBe(false);
    expect(getThreadAutoApprove("existing")).toBe(true);
  });
});
