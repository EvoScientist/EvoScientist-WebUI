// Auto-report: a finished async sub-agent's result is looped back to the main
// agent (the "[Async tasks update]" signal, so the main agent fetches it via
// check_async_task and integrates). Always on — there's no per-thread opt-out,
// no toggle UI. Only the reported-keys ledger is persisted, so we don't replay
// completions across reloads or after the auto-report effect first mounts on
// an existing thread.
//
// Consumed by the auto-injection effect in ChatInterface's chat view; on-off
// state and its former pub/sub used to live here too, both removed with the
// Agents inspector tab.

const REPORTED_STORAGE_KEY = "evoscientist-auto-notify-reported";

interface ReportedState {
  initialized: boolean;
  keys: string[];
}

function loadReported(): Record<string, ReportedState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(REPORTED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, ReportedState>;
    }
  } catch {
    // Corrupt/unavailable storage → rebuild the baseline when needed.
  }
  return {};
}

function saveReported(map: Record<string, ReportedState>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(REPORTED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Persistence failure is non-fatal; the current session still dedups via UI.
  }
}

export function getThreadAutoNotifyReportedKeys(
  threadId: string | null
): Set<string> {
  if (!threadId) return new Set();
  const state = loadReported()[threadId];
  return new Set(Array.isArray(state?.keys) ? state.keys : []);
}

export function isThreadAutoNotifyInitialized(
  threadId: string | null
): boolean {
  if (!threadId) return false;
  return loadReported()[threadId]?.initialized === true;
}

export function initializeThreadAutoNotifyReports(
  threadId: string | null,
  keys: Iterable<string>
): void {
  if (!threadId) return;
  const map = loadReported();
  const existing = map[threadId];
  map[threadId] = {
    initialized: true,
    keys: Array.from(new Set([...(existing?.keys ?? []), ...keys])),
  };
  saveReported(map);
}

export function markThreadAutoNotifyReported(
  threadId: string | null,
  key: string
): void {
  if (!threadId) return;
  const map = loadReported();
  const existing = map[threadId];
  map[threadId] = {
    initialized: existing?.initialized ?? true,
    keys: Array.from(new Set([...(existing?.keys ?? []), key])),
  };
  saveReported(map);
}
