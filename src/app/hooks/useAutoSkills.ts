"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { useDeployment } from "@/providers/ClientProvider";
import { parseDraftList, type Draft, type DraftList } from "@/lib/autoskills";

// One SWR read per deployment feeds the rail count, the banner, the drafts
// page and the detail pane.

export const AUTOSKILLS_REFRESH_MS = 60_000;

export type AutoSkillsState =
  | { status: "loading" }
  | { status: "unsupported" }
  | { status: "error"; error: Error }
  | { status: "ready"; list: DraftList };

type ListKey = readonly ["autoskills", string, string];

function headersFor(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

async function fetchDrafts([, base, apiKey]: ListKey): Promise<
  DraftList | "unsupported"
> {
  const res = await fetch(`${base}/api/autoskills/proposals`, {
    headers: headersFor(apiKey),
    cache: "no-store",
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
}

function baseOf(deploymentUrl: string): string | null {
  return deploymentUrl ? deploymentUrl.replace(/\/$/, "") : null;
}

/** The current deployment's drafts. */
export function useAutoSkills(): AutoSkillsState & {
  refresh: () => Promise<DraftList | "unsupported" | undefined>;
} {
  const { deploymentUrl, apiKey } = useDeployment();
  const base = baseOf(deploymentUrl);
  const key: ListKey | null = base ? ["autoskills", base, apiKey] : null;
  const { data, error, mutate } = useSWR(key, fetchDrafts, {
    // An EvoScientist without the route isn't asked again on the interval:
    // every page mounts the rail's count. Focus still reads again, so an
    // updated core is found.
    refreshInterval: (latest) =>
      latest === "unsupported" ? 0 : AUTOSKILLS_REFRESH_MS,
    revalidateOnFocus: true,
  });
  // The latest read decides: a failed re-read shows the error, not the old
  // list (SWR keeps `data` next to `error`; a later success clears the error).
  let state: AutoSkillsState;
  if (error) state = { status: "error", error: error as Error };
  else if (data === "unsupported") state = { status: "unsupported" };
  else if (data) state = { status: "ready", list: data };
  else state = { status: "loading" };
  return { ...state, refresh: mutate };
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
  404: "This file isn't there any more.",
  413: "This file is too large to show here.",
  415: "This file isn't text, so it isn't shown.",
};
// Answers that asking again won't change: these, and a 400 (a path the core
// refuses), which reads as the plain message.
const FINAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 415]);

class DraftFileError extends Error {
  readonly final: boolean;
  constructor(message: string, final: boolean) {
    super(message);
    this.final = final;
  }
}

async function fetchDraftFile([
  ,
  base,
  apiKey,
  id,
  ,
  path,
  installed,
]: FileKey): Promise<string> {
  const url =
    `${base}/api/autoskills/proposals/${encodeURIComponent(id)}/file` +
    `?path=${encodeURIComponent(path)}${installed ? "&installed=1" : ""}`;
  try {
    const res = await fetch(url, {
      headers: headersFor(apiKey),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new DraftFileError(
        FILE_ERRORS[res.status] ?? FILE_FALLBACK,
        FINAL_STATUSES.has(res.status)
      );
    }
    return await res.text();
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
      ? [
          "autoskills-file",
          base,
          apiKey,
          draft.proposal_id,
          draft.updated_at,
          path,
          installed,
        ]
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
