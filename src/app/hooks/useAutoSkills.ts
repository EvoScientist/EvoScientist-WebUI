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
    refreshInterval: AUTOSKILLS_REFRESH_MS,
    revalidateOnFocus: true,
  });
  let state: AutoSkillsState;
  if (data === "unsupported") state = { status: "unsupported" };
  else if (data) state = { status: "ready", list: data };
  else if (error) state = { status: "error", error: error as Error };
  else state = { status: "loading" };
  return { ...state, refresh: mutate };
}

/** Read every mounted AutoSkills list again, whatever its deployment. */
export function refreshAutoSkills(): Promise<unknown> {
  return globalMutate((key) => Array.isArray(key) && key[0] === "autoskills");
}

type FileKey = readonly [
  "autoskills-file",
  string,
  string,
  string,
  string,
  boolean
];

const FILE_ERRORS: Record<number, string> = {
  404: "This file isn't there any more.",
  413: "This file is too large to show here.",
  415: "This file isn't text, so it isn't shown.",
};

async function fetchDraftFile([
  ,
  base,
  apiKey,
  id,
  path,
  installed,
]: FileKey): Promise<string> {
  const url =
    `${base}/api/autoskills/proposals/${encodeURIComponent(id)}/file` +
    `?path=${encodeURIComponent(path)}${installed ? "&installed=1" : ""}`;
  const res = await fetch(url, {
    headers: headersFor(apiKey),
    cache: "no-store",
  });
  if (!res.ok)
    throw new Error(FILE_ERRORS[res.status] ?? "Couldn't read this file.");
  return res.text();
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
      ? ["autoskills-file", base, apiKey, draft.proposal_id, path, installed]
      : null;
  const { data, error, isLoading } = useSWR(key, fetchDraftFile);
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
  const at = readSeen()[deploymentUrl];
  return typeof at === "string" ? at : null;
}

export function markAutoSeen(deploymentUrl: string, at: string): void {
  try {
    localStorage.setItem(
      SEEN_KEY,
      JSON.stringify({ ...readSeen(), [deploymentUrl]: at })
    );
  } catch {
    // Storage can be blocked or full; the mark is a convenience.
  }
}
