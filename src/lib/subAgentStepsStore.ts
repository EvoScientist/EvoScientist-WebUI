import type { SubAgentStep } from "@/lib/subAgentActivity";

const STORAGE_KEY = "evoscientist-subagent-steps-v2";
const LEGACY_STORAGE_KEY = "evoscientist-subagent-steps";
const STORE_VERSION = 1;
const MAX_THREADS = 20;
const MAX_STEPS_PER_TASK = 200;
const MAX_TEXT_LENGTH = 10_000;
const MAX_ARG_STRING_LENGTH = 5_000;
const MAX_ARG_DEPTH = 8;
const TRUNCATION_SUFFIX = "…[truncated]";

interface StoredThreadSteps {
  updatedAt: number;
  tasks: Record<string, SubAgentStep[]>;
}

type StoreShape = Record<string, StoredThreadSteps>;

interface StoreEnvelope {
  version: typeof STORE_VERSION;
  threads: StoreShape;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function load(): StoreShape {
  if (typeof window === "undefined") return {};
  let currentRaw: string | null;
  let legacyRaw: string | null;
  try {
    currentRaw = localStorage.getItem(STORAGE_KEY);
    legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return {};
  }
  const current = parseJson(currentRaw) as Partial<StoreEnvelope> | null;
  if (
    current?.version === STORE_VERSION &&
    current.threads &&
    typeof current.threads === "object" &&
    !Array.isArray(current.threads)
  ) {
    return current.threads as StoreShape;
  }

  // The first Claude Code implementation stored the thread map directly.
  // Migrate it once so existing locally captured traces survive this cleanup.
  const legacy = parseJson(legacyRaw);
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const threads = legacy as StoreShape;
    save(threads);
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Storage can be disabled even when reads succeeded; keep the legacy copy.
    }
    return threads;
  }
  return {};
}

function save(store: StoreShape): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: StoreEnvelope = { version: STORE_VERSION, threads: store };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Trace caching is best-effort; chat and HITL must keep working without it.
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + TRUNCATION_SUFFIX : text;
}

function capArgValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return truncate(value, MAX_ARG_STRING_LENGTH);
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_ARG_DEPTH) return TRUNCATION_SUFFIX;
  if (Array.isArray(value)) {
    return value.map((item) => capArgValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = capArgValue(item, depth + 1);
  }
  return out;
}

function capStep(step: SubAgentStep): SubAgentStep {
  if (step.kind === "tool_call") {
    return {
      ...step,
      args: capArgValue(step.args, 0) as Record<string, unknown>,
    };
  }
  if (step.text.length <= MAX_TEXT_LENGTH) return step;
  return { ...step, text: truncate(step.text, MAX_TEXT_LENGTH) };
}

function isStoredStep(value: unknown): value is SubAgentStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Record<string, unknown>;
  if (step.kind === "tool_call") {
    return (
      typeof step.id === "string" &&
      typeof step.name === "string" &&
      !!step.args &&
      typeof step.args === "object" &&
      !Array.isArray(step.args)
    );
  }
  if (step.kind === "tool_result") {
    return (
      typeof step.toolCallId === "string" &&
      typeof step.name === "string" &&
      typeof step.text === "string"
    );
  }
  return step.kind === "text" && typeof step.text === "string";
}

export function loadThreadSubAgentSteps(
  threadId: string
): Record<string, SubAgentStep[]> {
  const entry = load()[threadId];
  if (!entry || typeof entry !== "object") return {};
  const tasks = entry.tasks;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return {};
  const out: Record<string, SubAgentStep[]> = {};
  for (const [taskId, value] of Object.entries(tasks)) {
    if (Array.isArray(value) && value.length > 0 && value.every(isStoredStep)) {
      out[taskId] = value.slice(-MAX_STEPS_PER_TASK);
    }
  }
  return out;
}

export function saveThreadSubAgentSteps(
  threadId: string,
  map: Record<string, SubAgentStep[]>
): void {
  const persistable: Record<string, SubAgentStep[]> = {};
  for (const [taskId, steps] of Object.entries(map)) {
    if (!Array.isArray(steps) || steps.length === 0) continue;
    persistable[taskId] = steps.slice(-MAX_STEPS_PER_TASK).map(capStep);
  }
  const store = load();
  if (Object.keys(persistable).length === 0) {
    if (!store[threadId]) return;
    delete store[threadId];
    save(store);
    return;
  }
  store[threadId] = { updatedAt: Date.now(), tasks: persistable };
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
