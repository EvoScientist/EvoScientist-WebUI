// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getThreadAutoNotifyReportedKeys,
  initializeThreadAutoNotifyReports,
  isThreadAutoNotifyInitialized,
  markThreadAutoNotifyReported,
} from "./autoNotify";

const REPORTED_STORAGE_KEY = "evoscientist-auto-notify-reported";

describe("autoNotify", () => {
  beforeEach(() => {
    localStorage.clear();
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
