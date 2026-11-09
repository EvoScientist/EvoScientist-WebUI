"use client";

import { useCallback } from "react";
import useSWR, {
  mutate as globalMutate,
  unstable_serialize,
  useSWRConfig,
} from "swr";
import { useDeployment } from "@/providers/ClientProvider";
import {
  MAX_SHOWN_BYTES,
  parseDraftList,
  unshowableFiles,
  type Draft,
  type DraftList,
  type FileReadOutcome,
  type UnshowableFile,
} from "@/lib/autoskills";

// One SWR read per deployment feeds the rail count, the banner, the drafts
// page and the detail pane.

export const AUTOSKILLS_REFRESH_MS = 60_000;
/** How long one read of the drafts or of a draft's file may take. SWR keeps
 *  a request in flight for its key, and every later read of the key waits
 *  for it: one that never answered stopped the list for good. */
export const READ_TIMEOUT_MS = 15_000;

export type AutoSkillsState =
  | { status: "loading" }
  | { status: "unsupported" }
  | { status: "error"; error: Error }
  | { status: "ready"; list: DraftList };

type ListKey = readonly ["autoskills", string, string];

/** `run(signal)`, given up on (aborted, rejecting) after READ_TIMEOUT_MS or
 *  when `outer` aborts. It rejects even when the request ignores the abort. */
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (outer?.aborted) stop();
  else outer?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, READ_TIMEOUT_MS);
  try {
    return await new Promise<T>((resolve, reject) => {
      const aborted = () =>
        reject(
          controller.signal.reason ?? new DOMException("Aborted", "AbortError")
        );
      if (controller.signal.aborted) {
        aborted();
        return;
      }
      controller.signal.addEventListener("abort", aborted, { once: true });
      run(controller.signal).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

function headersFor(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

async function fetchDrafts(
  [, base, apiKey]: ListKey,
  signal?: AbortSignal
): Promise<DraftList | "unsupported"> {
  return bounded(async (bound) => {
    const res = await fetch(`${base}/api/autoskills/proposals`, {
      headers: headersFor(apiKey),
      cache: "no-store",
      signal: bound,
    });
    // Deployments without the routes (EvoScientist before AutoSkills review).
    if (res.status === 404 || res.status === 405) return "unsupported";
    if (!res.ok) {
      throw new Error(`GET /api/autoskills/proposals answered ${res.status}`);
    }
    const list = parseDraftList(await res.json());
    if (!list) {
      throw new Error(
        "GET /api/autoskills/proposals answered an unexpected body"
      );
    }
    return list;
  }, signal);
}

function baseOf(deploymentUrl: string): string | null {
  return deploymentUrl ? deploymentUrl.replace(/\/$/, "") : null;
}

/** An EvoScientist without the route isn't asked again on the interval:
 *  every page mounts the rail's count. The one that started with the page
 *  may ask once more; focus still reads again, so an updated core is found.
 *  Module scope on purpose: SWR starts its timer over whenever this
 *  function changes, and the rail re-renders on its own clock. */
function refreshEvery(latest: DraftList | "unsupported" | undefined): number {
  return latest === "unsupported" ? 0 : AUTOSKILLS_REFRESH_MS;
}

/** The current deployment's drafts. `poll: false` is for a reader that only
 *  needs the list the others keep fresh (Run now's, mounted for the whole
 *  page): SWR runs an interval per reader and dedupes only reads a moment
 *  apart, so its own would double the reads. Focus and reconnect reads stay
 *  on: SWR sends them to a key's first reader only, which may be this one. */
export function useAutoSkills(
  options: { poll?: boolean } = {}
): AutoSkillsState & {
  /** Read again for every reader. Its answer is SWR's cache, which keeps
   *  the last good list when a read fails: never count on it as fresh. */
  refresh: () => Promise<DraftList | "unsupported" | undefined>;
  /** The drafts as the backend has them now, read directly, for the caller
   *  alone; then SWR reads again for every reader. Rejects when the read
   *  fails or is aborted. */
  readNow: (signal?: AbortSignal) => Promise<DraftList | "unsupported">;
  /** Whether a read of the list is in flight (SWR's own flag for the key).
   *  A read a newer one replaced keeps it true when it succeeds, but clears
   *  it when it fails, with the error as the state. So false with a
   *  "ready" state means the list shown came from the newest read. */
  isValidating: boolean;
} {
  const { deploymentUrl, apiKey } = useDeployment();
  const base = baseOf(deploymentUrl);
  const key: ListKey | null = base ? ["autoskills", base, apiKey] : null;
  const swr = useSWR(key, fetchDrafts, {
    refreshInterval: options.poll === false ? 0 : refreshEvery,
    revalidateOnFocus: true,
  });
  const { data, error, mutate } = swr;
  const { mutate: mutateCache } = useSWRConfig();
  const readNow = useCallback(
    async (signal?: AbortSignal) => {
      if (!base) throw new Error("No deployment to read the drafts from.");
      // This deployment's key, kept: the hook's own mutate would follow a
      // switch made while the read was out.
      const at: ListKey = ["autoskills", base, apiKey];
      try {
        return await fetchDrafts(at, signal);
      } finally {
        // The answer isn't written into the cache: a slow one could land
        // after a newer read of the list and bring back what changed. SWR
        // reads again instead, in its own order.
        try {
          void Promise.resolve(mutateCache(at)).catch(() => {});
        } catch {
          // The next poll reads again.
        }
      }
    },
    [base, apiKey, mutateCache]
  );
  // The latest read decides: a failed re-read shows the error, not the old
  // list (SWR keeps `data` next to `error`; a later success clears the error).
  let state: AutoSkillsState;
  if (error) state = { status: "error", error: error as Error };
  else if (data === "unsupported") state = { status: "unsupported" };
  else if (data) state = { status: "ready", list: data };
  else state = { status: "loading" };
  return {
    ...state,
    refresh: mutate,
    readNow,
    // A getter: SWR re-renders on a read starting or ending only the
    // callers that read this (the drafts page), not every reader of the list.
    get isValidating() {
      return swr.isValidating;
    },
  };
}

/** Read every mounted AutoSkills list again, whatever its deployment. */
export function refreshAutoSkills(): Promise<unknown> {
  return globalMutate((key) => Array.isArray(key) && key[0] === "autoskills");
}

// The draft's updated_at is part of the key: a run that rewrites a pending
// draft in place keeps its id, and its files must be read again.
type FileKey = readonly [
  "autoskills-file",
  string,
  string,
  string,
  string,
  string,
  boolean
];

const FILE_FALLBACK = "Couldn't read this file.";
const FILE_ERRORS: Record<number, string> = {
  // No such file or draft, no installed copy, or a file the core can't read.
  404: "This file is gone or can't be read.",
  413: "This file is too large to show here.",
  415: "This file isn't text, so it isn't shown.",
};
// Answers that asking again won't change: these, and a 400 (a path the core
// refuses), which reads as the plain message.
const FINAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 415]);

class DraftFileError extends Error {
  readonly final: boolean;
  /** The core's answer; null when there was none (network, timeout). */
  readonly status: number | null;
  constructor(message: string, final: boolean, status: number | null = null) {
    super(message);
    this.final = final;
    this.status = status;
  }
}

function fileKey(
  base: string,
  apiKey: string,
  draft: Draft,
  path: string,
  installed: boolean
): FileKey {
  return [
    "autoskills-file",
    base,
    apiKey,
    draft.proposal_id,
    draft.updated_at,
    path,
    installed,
  ];
}

/** SWR calls it with the key alone; the check before an approval also
 *  passes its own signal, which stops the read with the check. */
async function fetchDraftFile(
  [, base, apiKey, id, , path, installed]: FileKey,
  outer?: AbortSignal
): Promise<string> {
  const url =
    `${base}/api/autoskills/proposals/${encodeURIComponent(id)}/file` +
    `?path=${encodeURIComponent(path)}${installed ? "&installed=1" : ""}`;
  try {
    // A read that times out is a failed one, asked again.
    return await bounded(async (signal) => {
      const res = await fetch(url, {
        headers: headersFor(apiKey),
        cache: "no-store",
        signal,
      });
      if (!res.ok) {
        throw new DraftFileError(
          FILE_ERRORS[res.status] ?? FILE_FALLBACK,
          FINAL_STATUSES.has(res.status),
          res.status
        );
      }
      return await res.text();
    }, outer);
  } catch (e) {
    if (e instanceof DraftFileError) throw e;
    throw new DraftFileError(FILE_FALLBACK, false);
  }
}

/** One file of a draft (or its installed copy), read on demand. */
export function useDraftFile(
  draft: Draft | null,
  path: string | null,
  installed: boolean
): { text: string | null; error: string | null; loading: boolean } {
  const { deploymentUrl, apiKey } = useDeployment();
  const base = baseOf(deploymentUrl);
  const key: FileKey | null =
    base && draft && path
      ? fileKey(base, apiKey, draft, path, installed)
      : null;
  const { data, error, isLoading } = useSWR(key, fetchDraftFile, {
    // A missing, too large or binary file will not change by asking again.
    shouldRetryOnError: (e) => !(e instanceof DraftFileError && e.final),
  });
  return {
    text: data ?? null,
    error: error ? (error as Error).message : null,
    loading: isLoading,
  };
}

/** How many of a check's files are read at a time. */
const CHECK_READS = 4;
/** How long a whole check may take. Each read is bounded on its own, but a
 *  backend that never answers would hold the page busy for READ_TIMEOUT_MS
 *  per CHECK_READS files. */
export const CHECK_DEADLINE_MS = 20_000;

/** Each draft of a check with the files the page can't show; a draft
 *  without any isn't in it. */
export type UnshowableByDraft = ReadonlyMap<string, UnshowableFile[]>;

/** What an answer to a file read says about showing it. */
function outcomeOf(error: unknown): FileReadOutcome {
  if (error instanceof DraftFileError) {
    if (error.status === 413) return "too_large";
    if (error.status === 415) return "not_text";
  }
  return "unchecked";
}

/** What the Files tab's cache already knows about a file: shown, or a
 *  final 413 / 415; null when it has to be read. */
function knownOutcome(
  state: { data?: unknown; error?: unknown } | undefined
): FileReadOutcome | null {
  if (!state) return null;
  if (state.data !== undefined) return "shown";
  const outcome = outcomeOf(state.error);
  return outcome === "unchecked" ? null : outcome;
}

/** Run `tasks`, at most `limit` at a time; none starts once `stop` is
 *  aborted. */
async function inTurns(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit: number,
  stop: AbortSignal
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !stop.aborted) await tasks[next++]();
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
}

/** The check before an approval: the files of each draft the page can't
 *  show. A file listed over MAX_SHOWN_BYTES is known by its size; every
 *  other one is read as the Files tab reads it (its route, its fetcher and
 *  its SWR key, so a file opened before isn't read again and one read here
 *  opens at once), at most CHECK_READS at a time, each read bounded like
 *  the tab's. A 413 or 415 says the page can't show it; any other failure
 *  that it couldn't be checked. The whole check ends after
 *  CHECK_DEADLINE_MS, or when `stop` aborts: the reads out are stopped, no
 *  other starts, and every file without an answer couldn't be checked. The
 *  files are the drafts' current ones (their updated_at is in the key).
 *  Answers at once, without a promise, when nothing has to be read; never
 *  rejects. */
export function useDraftFilesCheck(): (
  drafts: readonly Draft[],
  stop?: AbortSignal
) => UnshowableByDraft | Promise<UnshowableByDraft> {
  const { deploymentUrl, apiKey } = useDeployment();
  const base = baseOf(deploymentUrl);
  const { cache, mutate } = useSWRConfig();
  return useCallback(
    (drafts: readonly Draft[], stop?: AbortSignal) => {
      const reads = new Map<string, Map<string, FileReadOutcome>>();
      // Ends the check: the deadline, or the caller's stop.
      const ended = new AbortController();
      const toRead: Array<() => Promise<void>> = [];
      for (const draft of drafts) {
        const outcomes = new Map<string, FileReadOutcome>();
        reads.set(draft.proposal_id, outcomes);
        for (const { path, size } of draft.files) {
          if (size > MAX_SHOWN_BYTES) continue;
          if (!base) {
            outcomes.set(path, "unchecked");
            continue;
          }
          const key = fileKey(base, apiKey, draft, path, false);
          const known = knownOutcome(cache.get(unstable_serialize(key)));
          if (known) {
            outcomes.set(path, known);
            continue;
          }
          toRead.push(async () => {
            let outcome: FileReadOutcome;
            try {
              const text = await fetchDraftFile(key, ended.signal);
              outcome = "shown";
              // Into the tab's cache, without reading it again.
              try {
                void Promise.resolve(
                  mutate(key, text, { revalidate: false })
                ).catch(() => {});
              } catch {
                // Opening the file reads it then.
              }
            } catch (e) {
              outcome = outcomeOf(e);
            }
            outcomes.set(path, outcome);
          });
        }
      }
      const found = (): UnshowableByDraft => {
        const out = new Map<string, UnshowableFile[]>();
        for (const draft of drafts) {
          const files = unshowableFiles(
            draft.files,
            reads.get(draft.proposal_id) ?? new Map()
          );
          if (files.length > 0) out.set(draft.proposal_id, files);
        }
        return out;
      };
      if (toRead.length === 0) return found();
      const end = () => ended.abort();
      if (stop?.aborted) end();
      else stop?.addEventListener("abort", end, { once: true });
      const deadline = setTimeout(end, CHECK_DEADLINE_MS);
      return inTurns(toRead, CHECK_READS, ended.signal).then(() => {
        clearTimeout(deadline);
        stop?.removeEventListener("abort", end);
        return found();
      });
    },
    [base, apiKey, cache, mutate]
  );
}

const SEEN_KEY = "evoscientist-autoskills-seen-at";

function readSeen(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function readAutoSeenAt(deploymentUrl: string): string | null {
  const at = readSeen()[baseOf(deploymentUrl) ?? deploymentUrl];
  return typeof at === "string" ? at : null;
}

export function markAutoSeen(deploymentUrl: string, at: string): void {
  try {
    localStorage.setItem(
      SEEN_KEY,
      JSON.stringify({
        ...readSeen(),
        [baseOf(deploymentUrl) ?? deploymentUrl]: at,
      })
    );
  } catch {
    // Storage can be blocked or full; the mark is a convenience.
  }
}
