import {
  dispatchLabel,
  dispatchType,
  sanitizeLine,
  type WorkflowDispatch,
  type WorkflowEval,
  type WorkflowMap,
} from "@/lib/dynamicWorkflow";

const STORAGE_KEY = "evoscientist-dynamic-workflows";
const MAX_THREADS = 20;
const MAX_DISPATCHES_PER_EVAL = 200;
const DISPATCH_STATUSES = new Set(["running", "done", "error", "cancelled"]);

interface StoredThreadWorkflows {
  updatedAt: number;
  evals: WorkflowMap;
}

type StoreShape = Record<string, StoredThreadWorkflows>;

function load(): StoreShape {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoreShape;
    }
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      return {};
    }
  }
  return {};
}

function save(store: StoreShape): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    return;
  }
}

function isStoredDispatch(value: unknown): value is WorkflowDispatch {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.label === "string" &&
    typeof d.subagentType === "string" &&
    typeof d.description === "string" &&
    typeof d.startedAt === "number" &&
    Number.isFinite(d.startedAt) &&
    typeof d.status === "string" &&
    DISPATCH_STATUSES.has(d.status) &&
    (d.durationMs === undefined ||
      (typeof d.durationMs === "number" &&
        Number.isFinite(d.durationMs) &&
        d.durationMs >= 0)) &&
    (d.error === undefined || typeof d.error === "string")
  );
}

function isStoredEval(value: unknown): value is WorkflowEval {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.evalId === "string" &&
    typeof e.updatedAt === "number" &&
    Number.isFinite(e.updatedAt) &&
    Array.isArray(e.dispatches) &&
    e.dispatches.every(isStoredDispatch)
  );
}

export function loadThreadWorkflows(threadId: string): WorkflowMap {
  const entry = load()[threadId];
  if (!entry || typeof entry !== "object") return {};
  const evals = entry.evals;
  if (!evals || typeof evals !== "object" || Array.isArray(evals)) return {};
  const out: WorkflowMap = {};
  for (const [key, value] of Object.entries(evals)) {
    if (isStoredEval(value)) {
      out[key] = {
        ...value,
        dispatches: value.dispatches
          .slice(-MAX_DISPATCHES_PER_EVAL)
          // Older versions stored blank types and labels. A label that shows
          // anything stays whole, like the id it can come from.
          .map((d) => {
            const subagentType = dispatchType(d.subagentType);
            return {
              ...d,
              subagentType,
              label:
                sanitizeLine(d.label, Infinity) ||
                dispatchLabel("", d.description, d.id, subagentType),
            };
          }),
      };
    }
  }
  return out;
}

export function saveThreadWorkflows(threadId: string, map: WorkflowMap): void {
  const persistable: WorkflowMap = {};
  for (const [key, evalData] of Object.entries(map)) {
    const terminal = evalData.dispatches.filter((d) => d.status !== "running");
    if (terminal.length === 0) continue;
    persistable[key] = {
      ...evalData,
      dispatches: terminal.slice(-MAX_DISPATCHES_PER_EVAL),
    };
  }
  const store = load();
  if (Object.keys(persistable).length === 0) {
    if (!store[threadId]) return;
    delete store[threadId];
    save(store);
    return;
  }
  store[threadId] = { updatedAt: Date.now(), evals: persistable };
  const ids = Object.keys(store);
  if (ids.length > MAX_THREADS) {
    const evictable = ids.filter((id) => id !== threadId);
    evictable.sort(
      (a, b) => (store[a]?.updatedAt ?? 0) - (store[b]?.updatedAt ?? 0)
    );
    for (const id of evictable.slice(0, ids.length - MAX_THREADS)) {
      delete store[id];
    }
  }
  save(store);
}
