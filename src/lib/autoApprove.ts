// Per-thread "auto-approve" preference, persisted in localStorage so it FOLLOWS
// each conversation: it survives switching views (Skills/Memory unmount the
// chat), switching to another thread, and page reloads. A thread that never
// turned it on simply has no entry (= off).
//
// The not-yet-created "New Chat" uses a sentinel key; once its first message
// creates a real thread id, `migrateNewThreadAutoApprove` carries the setting
// over to that id.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "evoscientist-auto-approve";
const NEW_THREAD_KEY = "__new__";
const CHANGE_EVENT = "evo-auto-approve-change";

function keyFor(threadId: string | null): string {
  return threadId ?? NEW_THREAD_KEY;
}

function load(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // Corrupt/unavailable storage → treat as empty (everything off).
  }
  return {};
}

function save(map: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota/private-mode failures are non-fatal — auto-approve just won't persist.
    // Nothing was stored, so there is nothing for subscribers to re-read.
    return;
  }
  revision += 1;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// Bumped on every write so `useAutoApproveRevision` has a snapshot that changes;
// the setting itself is always re-read from storage.
let revision = 0;

/** Subscribe to auto-approve changes (in-page via custom event, cross-tab via
 *  storage). Returns an unsubscribe function. */
export function subscribeAutoApprove(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    revision += 1;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Changes whenever any thread's auto-approve setting does. Components that read
 *  `getThreadAutoApprove` during render list it as a dependency to stay live. */
export function useAutoApproveRevision(): number {
  return useSyncExternalStore(
    subscribeAutoApprove,
    () => revision,
    () => 0
  );
}

/** Whether auto-approve is on for this thread (or the pending new chat). */
export function getThreadAutoApprove(threadId: string | null): boolean {
  return load()[keyFor(threadId)] === true;
}

/** Turn auto-approve on/off for this thread (or the pending new chat). */
export function setThreadAutoApprove(
  threadId: string | null,
  on: boolean
): void {
  const map = load();
  const key = keyFor(threadId);
  if (on) {
    map[key] = true;
  } else {
    // Store only "on" entries so absence == off and the map stays small.
    delete map[key];
  }
  save(map);
}

/**
 * When the pending new chat gets its real thread id, carry the sentinel setting
 * over to that id and clear the sentinel. No-op if it was never enabled.
 */
export function migrateNewThreadAutoApprove(newThreadId: string): void {
  const map = load();
  if (map[NEW_THREAD_KEY]) {
    map[newThreadId] = true;
  }
  if (NEW_THREAD_KEY in map) {
    delete map[NEW_THREAD_KEY];
    save(map);
  }
}
