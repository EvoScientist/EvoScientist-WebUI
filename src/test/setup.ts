// Vitest global setup for the test suite.
//
// Registered via `test.setupFiles` in vitest.config.ts so it runs before
// every test file. Adds React Testing Library's `cleanup()` after each test
// — without this, DOM from prior renders accumulates in `document.body`
// and `screen` queries return duplicate matches ("Multiple elements found").
// Vitest doesn't wire RTL's auto-cleanup by default the way Jest does.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
  };
}

if (
  typeof window !== "undefined" &&
  typeof globalThis.localStorage?.clear !== "function"
) {
  Object.defineProperty(globalThis, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
});
