import type { SubAgentStep } from "@/lib/subAgentActivity";

const STORAGE_KEY = "evoscientist-subagent-steps-v2";
const LEGACY_STORAGE_KEY = "evoscientist-subagent-steps";
const STORE_VERSION = 1;
const MAX_THREADS = 20;
const MAX_STEPS_PER_TASK = 200;
const MAX_TEXT_LENGTH = 10_000;
const MAX_ARG_STRING_LENGTH = 5_000;
const MAX_ARG_DEPTH = 8;
// The whole stored JSON, in characters: about 2 MB as UTF-16, well inside a
// browser's localStorage quota of about 5 MB.
const MAX_STORE_CHARS = 1_000_000;
export const TRUNCATION_SUFFIX = "…[truncated]";

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

  // The first Claude Code implementation stored the thread map directly. It is
  // read as it is; the next save moves it, fitted to the budget, under the
  // new key, so reading never drops a thread that is being opened.
  const legacy = parseJson(legacyRaw);
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    return legacy as StoreShape;
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
    return;
  }
  // Whatever the old key held is now under the new one.
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage can be disabled even when reads succeeded; keep the legacy copy.
  }
}

/** Removes the cache, the trace that matters least, when storage runs out. */
export function clearSubAgentStepsCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage is blocked; there is nothing to clear.
  }
}

const jsonLength = (value: unknown) => JSON.stringify(value).length;

/** How much shorter an object's JSON gets without one entry, given how many
 *  entries it has left after that. */
const entryLength = (key: string, value: unknown, left: number) =>
  jsonLength(key) + 1 + jsonLength(value) + (left > 0 ? 1 : 0);

/**
 * Keeps the stored JSON under the budget. The current thread first gets down
 * to what would fit on its own: its older tasks go, then the oldest steps of
 * its newest task, and a thread that can't fit even its last step isn't
 * kept. Then the least recently updated threads lose their oldest tasks.
 */
function fitBudget(store: StoreShape, threadId: string | null): void {
  let length = jsonLength({ version: STORE_VERSION, threads: store });
  if (length <= MAX_STORE_CHARS) return;
  let threadsLeft = Object.keys(store).length;
  const dropThread = (id: string) => {
    threadsLeft -= 1;
    length -= entryLength(id, store[id], threadsLeft);
    delete store[id];
  };
  const own = threadId === null ? undefined : store[threadId];
  if (threadId !== null && own) {
    // Cutting the thread shortens it alone and the whole store alike.
    let alone = jsonLength({
      version: STORE_VERSION,
      threads: { [threadId]: own },
    });
    const cut = (by: number) => {
      alone -= by;
      length -= by;
    };
    const taskIds = Object.keys(own.tasks);
    let tasksLeft = taskIds.length;
    for (const taskId of taskIds.slice(0, -1)) {
      if (alone <= MAX_STORE_CHARS) break;
      tasksLeft -= 1;
      cut(entryLength(taskId, own.tasks[taskId], tasksLeft));
      delete own.tasks[taskId];
    }
    // The latest steps are the ones worth keeping, as with the step cap.
    const newest = taskIds[taskIds.length - 1];
    const steps = own.tasks[newest] ?? [];
    let drop = 0;
    while (alone > MAX_STORE_CHARS && drop < steps.length - 1) {
      cut(jsonLength(steps[drop]) + 1);
      drop += 1;
    }
    if (drop > 0) own.tasks[newest] = steps.slice(drop);
    if (alone > MAX_STORE_CHARS) dropThread(threadId);
    if (length <= MAX_STORE_CHARS) return;
  }
  const others = Object.keys(store)
    .filter((id) => id !== threadId)
    .sort((a, b) => (store[a]?.updatedAt ?? 0) - (store[b]?.updatedAt ?? 0));
  for (const id of others) {
    const tasks = store[id]?.tasks;
    // Found in a stored entry, a list that isn't a map can't be counted.
    if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) {
      dropThread(id);
    } else {
      const taskIds = Object.keys(tasks);
      let tasksLeft = taskIds.length;
      for (const taskId of taskIds) {
        if (length <= MAX_STORE_CHARS) break;
        tasksLeft -= 1;
        length -= entryLength(taskId, tasks[taskId], tasksLeft);
        delete tasks[taskId];
      }
      // A thread left without tasks goes too.
      if (tasksLeft === 0) dropThread(id);
    }
    if (length <= MAX_STORE_CHARS) return;
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
      typeof step.text === "string" &&
      (step.failed === undefined || step.failed === true)
    );
  }
  if (step.kind === "reasoning") {
    return typeof step.text === "string" && typeof step.markdown === "boolean";
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
    // A store written before the budget can still be over it.
    fitBudget(store, null);
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
  fitBudget(store, threadId);
  save(store);
}
