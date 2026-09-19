// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  getThreadAutoApprove,
  migrateNewThreadAutoApprove,
  setThreadAutoApprove,
  subscribeAutoApprove,
  useAutoApproveRevision,
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

describe("autoApprove change notifications", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("notifies subscribers when a thread's setting changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoApprove(listener);
    setThreadAutoApprove("t1", true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setThreadAutoApprove("t1", false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies when the sentinel migrates onto a real thread id", () => {
    setThreadAutoApprove(null, true);
    const listener = vi.fn();
    const unsubscribe = subscribeAutoApprove(listener);
    migrateNewThreadAutoApprove("t1");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stays quiet when the write fails, since nothing changed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoApprove(listener);
    // The suite's localStorage is a plain in-memory object (src/test/setup.ts),
    // so the spy goes on the instance, not on Storage.prototype.
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    setThreadAutoApprove("t1", true);
    setItem.mockRestore();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(getThreadAutoApprove("t1")).toBe(false);
  });

  it("notifies on a cross-tab storage event", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoApprove(listener);
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("useAutoApproveRevision re-renders consumers on change", () => {
    const { result } = renderHook(() => useAutoApproveRevision());
    const before = result.current;
    act(() => {
      setThreadAutoApprove("t1", true);
    });
    expect(result.current).not.toBe(before);
  });
});
