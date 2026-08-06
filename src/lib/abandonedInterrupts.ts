// Per-thread record of tool-approval interrupts the user ABANDONED (via the Stop
// button or Reject). Persisted in localStorage so the abandon survives a page
// reload: without it, `reconnectOnMount` + the recovery poll re-fetch the thread's
// still-pending interrupt and drop the user right back onto the approval card they
// just dismissed (the in-session `userAborted` flag is React state, lost on reload).
//
// Keyed by `interruptValueKey(...)` (the interrupt's stable content key), so a
// genuinely NEW interrupt is never suppressed. Cleared for a thread as soon as the
// user moves forward (sends a message / resumes), since a new turn supersedes the
// abandoned run server-side anyway.

const STORAGE_KEY = "evoscientist-abandoned-interrupts";

function load(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string[]>;
    }
  } catch {
    // Corrupt/unavailable storage → treat as empty (nothing abandoned).
  }
  return {};
}

function save(map: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota/private-mode failures are non-fatal — abandon just won't persist.
  }
}

/** The set of abandoned interrupt keys for a thread (empty for a fresh thread). */
export function getAbandonedInterruptKeys(
  threadId: string | null | undefined
): Set<string> {
  if (!threadId) return new Set();
  const entry = load()[threadId];
  return new Set(
    Array.isArray(entry) ? entry.filter((k) => typeof k === "string") : []
  );
}

/** Record that this interrupt key was abandoned on this thread. */
export function addAbandonedInterruptKey(
  threadId: string | null | undefined,
  key: string | null | undefined
): void {
  if (!threadId || !key) return;
  const map = load();
  const list = Array.isArray(map[threadId]) ? map[threadId] : [];
  if (list.includes(key)) return;
  map[threadId] = [...list, key];
  save(map);
}

/** Forget everything abandoned on this thread — the user is moving forward. */
export function clearAbandonedInterrupts(
  threadId: string | null | undefined
): void {
  if (!threadId) return;
  const map = load();
  if (threadId in map) {
    delete map[threadId];
    save(map);
  }
}
