export type DispatchStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowDispatch {
  id: string;
  label: string;
  subagentType: string;
  description: string;
  status: DispatchStatus;
  startedAt: number;
  durationMs?: number;
  error?: string;
}

export interface WorkflowEval {
  evalId: string;
  dispatches: WorkflowDispatch[];
  updatedAt: number;
}

export type WorkflowMap = Record<string, WorkflowEval>;

export type SubagentEvent =
  | {
      phase: "start";
      id: string;
      evalId: string;
      subagentType: string;
      label: string;
      description: string;
    }
  | { phase: "complete"; id: string; evalId: string; durationMs: number }
  | {
      phase: "error";
      id: string;
      evalId: string;
      durationMs: number;
      error: string;
    };

const CONTROL_AND_BIDI = /[\p{Cc}\p{Bidi_Control}]/gu;

export const ROW_ERROR_MAX_CHARS = 120;
const LABEL_MAX_CHARS = 200;
const TYPE_MAX_CHARS = 60;
const LABEL_FALLBACK_MAX_CHARS = 60;
const STORED_ERROR_MAX_CHARS = 2000;

// Whitespace and what draws nothing: the default-ignorable characters (zero-
// width spaces and joiners, fillers, soft hyphens) and the blank braille cell.
const LEADING_BLANKS = /^[\s\p{Default_Ignorable_Code_Point}\u2800]+/u;

/** A space, or the first half of a character with nothing after it. */
function isLooseEnd(code: number): boolean {
  return code === 0x20 || (code >= 0xd800 && code <= 0xdbff);
}

/** One line of untrusted text: empty, or starting with something that shows. */
export function sanitizeLine(text: string, maxChars: number): string {
  const line = text
    .replace(CONTROL_AND_BIDI, " ")
    .replace(/\s+/g, " ")
    .replace(LEADING_BLANKS, "")
    .slice(0, maxChars);
  // Spaces and half characters (a cut can leave one) go from the end in one
  // pass, so cleaning the result again changes nothing.
  let end = line.length;
  while (end > 0 && isLooseEnd(line.charCodeAt(end - 1))) end--;
  return line.slice(0, end);
}

/** A dispatch's type, or "subagent" when it has none that shows. */
export function dispatchType(type: unknown): string {
  return (
    (typeof type === "string" && sanitizeLine(type, TYPE_MAX_CHARS)) ||
    "subagent"
  );
}

/**
 * The first of a dispatch's names that shows anything, else its type. The id
 * is shown whole, so ids that differ only at the end stay apart.
 */
export function dispatchLabel(
  label: string,
  description: string,
  id: string,
  subagentType: string
): string {
  return (
    sanitizeLine(label, LABEL_MAX_CHARS) ||
    sanitizeLine(description, LABEL_FALLBACK_MAX_CHARS) ||
    sanitizeLine(id, Infinity) ||
    subagentType
  );
}

function isTerminal(status: DispatchStatus): boolean {
  return status !== "running";
}

export function parseSubagentEvent(data: unknown): SubagentEvent | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (raw.type !== "subagent") return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const id = raw.id;
  const evalId = typeof raw.eval_id === "string" ? raw.eval_id : "";
  const durationMs =
    typeof raw.duration_ms === "number" && Number.isFinite(raw.duration_ms)
      ? Math.max(0, Math.round(raw.duration_ms))
      : 0;
  if (raw.phase === "start") {
    const description =
      typeof raw.description === "string"
        ? sanitizeLine(raw.description, LABEL_MAX_CHARS)
        : "";
    const subagentType = dispatchType(raw.subagent_type);
    return {
      phase: "start",
      id,
      evalId,
      subagentType,
      label: dispatchLabel(
        typeof raw.label === "string" ? raw.label : "",
        description,
        id,
        subagentType
      ),
      description,
    };
  }
  if (raw.phase === "complete") {
    return { phase: "complete", id, evalId, durationMs };
  }
  if (raw.phase === "error") {
    return {
      phase: "error",
      id,
      evalId,
      durationMs,
      error:
        typeof raw.error === "string"
          ? sanitizeLine(raw.error, STORED_ERROR_MAX_CHARS)
          : "",
    };
  }
  return null;
}

function findDispatch(
  map: WorkflowMap,
  id: string
): { evalKey: string; index: number } | null {
  for (const [evalKey, evalData] of Object.entries(map)) {
    const index = evalData.dispatches.findIndex((d) => d.id === id);
    if (index !== -1) return { evalKey, index };
  }
  return null;
}

function withEval(
  map: WorkflowMap,
  evalKey: string,
  now: number,
  dispatches: WorkflowDispatch[]
): WorkflowMap {
  const existing = map[evalKey];
  return {
    ...map,
    [evalKey]: {
      evalId: existing?.evalId ?? evalKey,
      dispatches,
      updatedAt: now,
    },
  };
}

export function applySubagentEvent(
  map: WorkflowMap,
  event: SubagentEvent,
  now: number
): WorkflowMap {
  const located = findDispatch(map, event.id);
  if (event.phase === "start") {
    if (located) {
      const evalData = map[located.evalKey];
      const existing = evalData.dispatches[located.index];
      if (isTerminal(existing.status)) return map;
      const dispatches = [...evalData.dispatches];
      dispatches[located.index] = {
        ...existing,
        label: event.label,
        subagentType: event.subagentType,
        description: event.description,
      };
      return withEval(map, located.evalKey, now, dispatches);
    }
    const evalData = map[event.evalId];
    const dispatch: WorkflowDispatch = {
      id: event.id,
      label: event.label,
      subagentType: event.subagentType,
      description: event.description,
      status: "running",
      startedAt: now,
    };
    return withEval(map, event.evalId, now, [
      ...(evalData?.dispatches ?? []),
      dispatch,
    ]);
  }
  if (!located) {
    if (event.phase === "complete") return map;
    const evalData = map[event.evalId];
    const orphan: WorkflowDispatch = {
      id: event.id,
      label: dispatchLabel("", "", event.id, "subagent"),
      subagentType: "subagent",
      description: "",
      status: "error",
      startedAt: now - event.durationMs,
      durationMs: event.durationMs,
      error: event.error,
    };
    return withEval(map, event.evalId, now, [
      ...(evalData?.dispatches ?? []),
      orphan,
    ]);
  }
  const evalData = map[located.evalKey];
  const existing = evalData.dispatches[located.index];
  if (isTerminal(existing.status)) return map;
  const dispatches = [...evalData.dispatches];
  dispatches[located.index] = {
    ...existing,
    status: event.phase === "complete" ? "done" : "error",
    durationMs: event.durationMs,
    error: event.phase === "error" ? event.error : undefined,
  };
  return withEval(map, located.evalKey, now, dispatches);
}

export function finalizeRunning(map: WorkflowMap, now: number): WorkflowMap {
  let changed = false;
  const next: WorkflowMap = {};
  for (const [evalKey, evalData] of Object.entries(map)) {
    if (!evalData.dispatches.some((d) => d.status === "running")) {
      next[evalKey] = evalData;
      continue;
    }
    changed = true;
    next[evalKey] = {
      ...evalData,
      updatedAt: now,
      dispatches: evalData.dispatches.map((d) =>
        d.status === "running"
          ? {
              ...d,
              status: "cancelled" as const,
              durationMs: Math.max(0, now - d.startedAt),
            }
          : d
      ),
    };
  }
  return changed ? next : map;
}

export function mergeWorkflowMaps(
  stored: WorkflowMap,
  live: WorkflowMap
): WorkflowMap {
  const next: WorkflowMap = { ...stored };
  for (const [evalKey, liveEval] of Object.entries(live)) {
    const storedEval = next[evalKey];
    if (!storedEval) {
      next[evalKey] = liveEval;
      continue;
    }
    const byId = new Map(storedEval.dispatches.map((d) => [d.id, d]));
    for (const d of liveEval.dispatches) {
      const prior = byId.get(d.id);
      if (!prior || isTerminal(d.status) || !isTerminal(prior.status)) {
        byId.set(d.id, d);
      }
    }
    const ordered: WorkflowDispatch[] = [];
    const seen = new Set<string>();
    for (const d of storedEval.dispatches) {
      ordered.push(byId.get(d.id) as WorkflowDispatch);
      seen.add(d.id);
    }
    for (const d of liveEval.dispatches) {
      if (!seen.has(d.id)) ordered.push(byId.get(d.id) as WorkflowDispatch);
    }
    next[evalKey] = {
      evalId: storedEval.evalId || liveEval.evalId,
      dispatches: ordered,
      updatedAt: Math.max(storedEval.updatedAt, liveEval.updatedAt),
    };
  }
  return next;
}

export interface WorkflowCounts {
  total: number;
  finished: number;
  failed: number;
  cancelled: number;
  running: number;
}

export function workflowCounts(evalData: WorkflowEval): WorkflowCounts {
  const counts: WorkflowCounts = {
    total: 0,
    finished: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
  };
  for (const d of evalData.dispatches) {
    counts.total += 1;
    if (d.status === "running") counts.running += 1;
    else counts.finished += 1;
    if (d.status === "error") counts.failed += 1;
    if (d.status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

export function dispatchElapsedMs(d: WorkflowDispatch, now: number): number {
  return d.durationMs ?? Math.max(0, now - d.startedAt);
}

export function workflowElapsedMs(evalData: WorkflowEval, now: number): number {
  if (evalData.dispatches.length === 0) return 0;
  const earliest = Math.min(...evalData.dispatches.map((d) => d.startedAt));
  if (evalData.dispatches.some((d) => d.status === "running")) {
    return Math.max(0, now - earliest);
  }
  const latestEnd = Math.max(
    ...evalData.dispatches.map((d) => d.startedAt + dispatchElapsedMs(d, now))
  );
  return Math.max(0, latestEnd - earliest);
}

export function formatWorkflowTiming(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export interface WorkflowAggregate {
  phaseCount: number;
  total: number;
  finished: number;
  failed: number;
  cancelled: number;
  running: number;
  runningLabel: string | null;
  activeEvalId: string | null;
}

export function aggregateWorkflows(map: WorkflowMap): WorkflowAggregate {
  const agg: WorkflowAggregate = {
    phaseCount: 0,
    total: 0,
    finished: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    runningLabel: null,
    activeEvalId: null,
  };
  let latestRunningStart = -1;
  let newestUpdated = -1;
  let newestEvalId: string | null = null;
  for (const [evalId, evalData] of Object.entries(map)) {
    if (evalData.dispatches.length === 0) continue;
    agg.phaseCount += 1;
    if (evalData.updatedAt > newestUpdated) {
      newestUpdated = evalData.updatedAt;
      newestEvalId = evalId;
    }
    const counts = workflowCounts(evalData);
    agg.total += counts.total;
    agg.finished += counts.finished;
    agg.failed += counts.failed;
    agg.cancelled += counts.cancelled;
    agg.running += counts.running;
    for (const d of evalData.dispatches) {
      if (d.status === "running" && d.startedAt > latestRunningStart) {
        latestRunningStart = d.startedAt;
        agg.runningLabel = d.label;
        agg.activeEvalId = evalId;
      }
    }
  }
  if (!agg.activeEvalId) agg.activeEvalId = newestEvalId;
  return agg;
}

export function sortWorkflowEvals(map: WorkflowMap): WorkflowEval[] {
  return Object.values(map)
    .filter((e) => e.dispatches.length > 0)
    .sort(
      (a, b) =>
        Math.min(...a.dispatches.map((d) => d.startedAt)) -
        Math.min(...b.dispatches.map((d) => d.startedAt))
    );
}
