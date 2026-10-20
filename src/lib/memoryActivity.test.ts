// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_RECENT_MS,
  getMemorySeenAt,
  isRecent,
  relativeTime,
  setMemorySeenAt,
} from "./memoryActivity";

const SEEN_KEY = "evoscientist-memory-seen-at";

describe("getMemorySeenAt", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns 0 when no baseline has been stored", () => {
    expect(getMemorySeenAt()).toBe(0);
  });

  it("returns the stored epoch-ms value", () => {
    localStorage.setItem(SEEN_KEY, "1700000000000");
    expect(getMemorySeenAt()).toBe(1700000000000);
  });

  it("returns 0 for a corrupted (non-numeric) stored value", () => {
    // Number("not a number") is NaN, which is not finite -> falls back to 0.
    localStorage.setItem(SEEN_KEY, "not a number");
    expect(getMemorySeenAt()).toBe(0);
  });

  describe("with storage blocked", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns 0", () => {
      const getItem = vi.fn(() => {
        throw new DOMException("Storage is disabled.", "SecurityError");
      });
      vi.stubGlobal("localStorage", { getItem });
      expect(getMemorySeenAt()).toBe(0);
      expect(getItem).toHaveBeenCalled();
    });
  });
});

describe("setMemorySeenAt", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores the timestamp as a string", () => {
    setMemorySeenAt(1700000000000);
    expect(localStorage.getItem(SEEN_KEY)).toBe("1700000000000");
  });

  // A prototype swap never runs on Node 25's storage, so the global is swapped.
  it("survives localStorage failure silently", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("The quota was exceeded.", "QuotaExceededError");
    });
    vi.stubGlobal("localStorage", { setItem });
    try {
      expect(() => setMemorySeenAt(123)).not.toThrow();
      expect(setItem).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isRecent", () => {
  const now = 1_700_000_000_000;

  it("returns false when mtime is 0", () => {
    expect(isRecent(0, now)).toBe(false);
  });

  it("returns true when mtime is within the window", () => {
    expect(isRecent(now - 1000, now)).toBe(true);
    expect(isRecent(now - MEMORY_RECENT_MS + 1, now)).toBe(true);
  });

  it("returns false when mtime is older than the window", () => {
    expect(isRecent(now - MEMORY_RECENT_MS, now)).toBe(false);
    expect(isRecent(now - MEMORY_RECENT_MS - 1, now)).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;

  it("returns empty string for a falsy mtime", () => {
    expect(relativeTime(0, now)).toBe("");
  });

  it("returns 'just now' for mtimes under 45 seconds ago", () => {
    expect(relativeTime(now - 1_000, now)).toBe("just now");
    expect(relativeTime(now - 44_000, now)).toBe("just now");
  });

  it("returns Xm ago for minute-scale ages", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  });

  it("returns Xh ago for hour-scale ages", () => {
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 5 * 60 * 60_000, now)).toBe("5h ago");
  });

  it("returns Xd ago for day-scale ages", () => {
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
    expect(relativeTime(now - 5 * 24 * 60 * 60_000, now)).toBe("5d ago");
  });

  it("clamps negative age to 'just now' (clock skew tolerance)", () => {
    // If mtime is somehow in the future, treat as just-now instead of "-1s".
    expect(relativeTime(now + 5_000, now)).toBe("just now");
  });
});
