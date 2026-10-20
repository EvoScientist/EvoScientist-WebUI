// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module keeps a config it couldn't store, so each test loads it fresh.
let getConfig: typeof import("./config").getConfig;
let saveConfig: typeof import("./config").saveConfig;
beforeEach(async () => {
  vi.resetModules();
  ({ getConfig, saveConfig } = await import("./config"));
});

const CONFIG_KEY = "evoscientist-config";
const STEPS_KEY = "evoscientist-subagent-steps-v2";
const WORKFLOWS_KEY = "evoscientist-dynamic-workflows";

/** A localStorage that refuses a write taking it past `capacity` characters,
 *  the way a browser's quota does. */
function storageWithQuota(
  capacity: number,
  seed: Record<string, string> = {},
  errorName = "QuotaExceededError"
) {
  const items = new Map(Object.entries(seed));
  const used = () =>
    [...items].reduce((n, [key, value]) => n + key.length + value.length, 0);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const before = items.get(key);
      items.set(key, String(value));
      if (used() > capacity) {
        if (before === undefined) items.delete(key);
        else items.set(key, before);
        throw new DOMException("The quota was exceeded.", errorName);
      }
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

const config = { deploymentUrl: "http://127.0.0.1:6174" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveConfig", () => {
  it("saves the config", () => {
    vi.stubGlobal("localStorage", storageWithQuota(10_000));
    expect(saveConfig(config)).toBe(true);
    expect(getConfig()).toEqual(config);
  });

  it("keeps the trace caches while the config fits", () => {
    const storage = storageWithQuota(10_000, {
      [STEPS_KEY]: "s",
      [WORKFLOWS_KEY]: "w",
    });
    vi.stubGlobal("localStorage", storage);
    saveConfig(config);
    expect([...storage.items.keys()].sort()).toEqual(
      [CONFIG_KEY, STEPS_KEY, WORKFLOWS_KEY].sort()
    );
  });

  // Older Firefox names the error NS_ERROR_DOM_QUOTA_REACHED.
  it.each(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"])(
    "clears the trace caches to make room when storage is full (%s)",
    (errorName) => {
      const storage = storageWithQuota(
        1_000,
        { [STEPS_KEY]: "s".repeat(500), [WORKFLOWS_KEY]: "w".repeat(400) },
        errorName
      );
      vi.stubGlobal("localStorage", storage);
      expect(saveConfig(config)).toBe(true);
      expect([...storage.items.keys()]).toEqual([CONFIG_KEY]);
      expect(getConfig()).toEqual(config);
    }
  );

  it("reports a config that still doesn't fit", () => {
    const storage = storageWithQuota(1_000, { other: "o".repeat(990) });
    vi.stubGlobal("localStorage", storage);
    expect(saveConfig(config)).toBe(false);
    expect(storage.items.has(CONFIG_KEY)).toBe(false);
  });

  it("leaves the caches alone when storage fails for another reason", () => {
    const storage = {
      ...storageWithQuota(10_000, { [STEPS_KEY]: "s" }),
      setItem: () => {
        throw new DOMException("Storage is disabled.", "SecurityError");
      },
    };
    vi.stubGlobal("localStorage", storage);
    expect(saveConfig(config)).toBe(false);
    expect(storage.items.has(STEPS_KEY)).toBe(true);
  });

  // Every reader of the config sees what the page uses until it is reloaded.
  it("keeps a config it couldn't store for the rest of the page's life", () => {
    const stored = { deploymentUrl: "http://[::1]:6174" };
    const storage = storageWithQuota(1_000, {
      [CONFIG_KEY]: JSON.stringify(stored),
      other: "o".repeat(940),
    });
    vi.stubGlobal("localStorage", storage);

    expect(saveConfig(config)).toBe(false);
    expect(getConfig()).toEqual(config);
    expect(JSON.parse(storage.items.get(CONFIG_KEY)!)).toEqual(stored);
  });

  // Settings, then Reconnect, both refused: the later URL is the one in use.
  it("keeps the latest config it couldn't store", () => {
    vi.stubGlobal(
      "localStorage",
      storageWithQuota(1_000, { other: "o".repeat(990) })
    );
    const later = { deploymentUrl: "http://127.0.0.1:6200" };
    expect(saveConfig(config)).toBe(false);
    expect(saveConfig(later)).toBe(false);
    expect(getConfig()).toEqual(later);
  });

  it("reads storage again once a save goes through", () => {
    const storage = storageWithQuota(1_000, { other: "o".repeat(990) });
    vi.stubGlobal("localStorage", storage);
    expect(saveConfig(config)).toBe(false);

    storage.items.delete("other");
    const next = { deploymentUrl: "http://127.0.0.1:6200" };
    expect(saveConfig(next)).toBe(true);
    // Another tab's save shows, so the page no longer holds its own copy.
    const elsewhere = { deploymentUrl: "http://127.0.0.1:6300" };
    storage.items.set(CONFIG_KEY, JSON.stringify(elsewhere));
    expect(getConfig()).toEqual(elsewhere);
  });
});

describe("getConfig", () => {
  it("reads no config when storage is blocked", () => {
    const getItem = vi.fn(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });
    vi.stubGlobal("localStorage", { getItem });
    expect(getConfig()).toBeNull();
    expect(getItem).toHaveBeenCalled();
  });
});
