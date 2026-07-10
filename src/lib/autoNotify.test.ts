// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getThreadAutoNotify,
  getThreadAutoNotifyReportedKeys,
  initializeThreadAutoNotifyReports,
  isThreadAutoNotifyInitialized,
  markThreadAutoNotifyReported,
  setThreadAutoNotify,
  subscribeAutoNotify,
} from "./autoNotify";

const STORAGE_KEY = "evoscientist-auto-notify";
const REPORTED_STORAGE_KEY = "evoscientist-auto-notify-reported";

function readStorage(): Record<string, boolean> {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
}

describe("autoNotify", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getThreadAutoNotify", () => {
    it("defaults to true for real thread ids with no entry", () => {
      expect(getThreadAutoNotify("t1")).toBe(true);
    });

    it("defaults to false for null (pending new chat)", () => {
      expect(getThreadAutoNotify(null)).toBe(false);
    });

    it("returns false only when explicitly stored as false", () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ t1: false }));
      expect(getThreadAutoNotify("t1")).toBe(false);
    });

    it("recovers from corrupt payloads", () => {
      localStorage.setItem(STORAGE_KEY, "not json");
      expect(getThreadAutoNotify("t1")).toBe(true);
    });
  });

  describe("setThreadAutoNotify", () => {
    it("stores only explicit off entries (on is the default)", () => {
      setThreadAutoNotify("t1", false);
      expect(readStorage()).toEqual({ t1: false });
      expect(getThreadAutoNotify("t1")).toBe(false);
    });

    it("turning back on removes the entry", () => {
      setThreadAutoNotify("t1", false);
      setThreadAutoNotify("t1", true);
      expect(readStorage()).toEqual({});
      expect(getThreadAutoNotify("t1")).toBe(true);
    });

    it("is a no-op for a null thread id", () => {
      setThreadAutoNotify(null, false);
      expect(readStorage()).toEqual({});
    });

    it("dispatches the change event so in-page subscribers fire", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeAutoNotify(listener);
      setThreadAutoNotify("t1", false);
      expect(listener).toHaveBeenCalledTimes(1);
      setThreadAutoNotify("t1", true);
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      setThreadAutoNotify("t1", false);
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe("reported keys", () => {
    it("returns an empty set for uninitialized threads", () => {
      expect(getThreadAutoNotifyReportedKeys("t1").size).toBe(0);
      expect(isThreadAutoNotifyInitialized("t1")).toBe(false);
    });

    it("returns an empty set for a null thread id", () => {
      expect(getThreadAutoNotifyReportedKeys(null).size).toBe(0);
    });

    it("initialize marks the thread and stores the initial keys", () => {
      initializeThreadAutoNotifyReports("t1", ["k1", "k2"]);
      expect(isThreadAutoNotifyInitialized("t1")).toBe(true);
      const keys = getThreadAutoNotifyReportedKeys("t1");
      expect(keys.has("k1")).toBe(true);
      expect(keys.has("k2")).toBe(true);
    });

    it("initialize dedupes keys against prior state", () => {
      initializeThreadAutoNotifyReports("t1", ["k1"]);
      initializeThreadAutoNotifyReports("t1", ["k1", "k2"]);
      const stored = JSON.parse(
        localStorage.getItem(REPORTED_STORAGE_KEY) as string
      );
      expect(new Set(stored.t1.keys)).toEqual(new Set(["k1", "k2"]));
    });

    it("markReported adds a key to the reported set", () => {
      initializeThreadAutoNotifyReports("t1", []);
      markThreadAutoNotifyReported("t1", "k1");
      markThreadAutoNotifyReported("t1", "k1"); // dedup
      markThreadAutoNotifyReported("t1", "k2");
      expect(getThreadAutoNotifyReportedKeys("t1")).toEqual(
        new Set(["k1", "k2"])
      );
    });

    it("markReported initializes if the thread was not marked yet", () => {
      markThreadAutoNotifyReported("t1", "k1");
      expect(isThreadAutoNotifyInitialized("t1")).toBe(true);
      expect(getThreadAutoNotifyReportedKeys("t1")).toEqual(new Set(["k1"]));
    });

    it("no-ops on null thread id", () => {
      initializeThreadAutoNotifyReports(null, ["k1"]);
      markThreadAutoNotifyReported(null, "k1");
      expect(localStorage.getItem(REPORTED_STORAGE_KEY)).toBeNull();
    });
  });
});
