"use client";

import { useCallback, useEffect, useState } from "react";

import { parseTeams, type TeamEntry } from "@/lib/teams";
import { useDeployment } from "@/providers/ClientProvider";

// The Experts view and the chat composer each hold their own instance, and
// the chat stays mounted behind the view. Installing a skill in one must
// refresh the other, or the composer's pill counts a stale list until a
// reload — same cross-component signal the auto-approve and auto-notify
// stores already use.
const CHANGE_EVENT = "evo-teams-change";

// One empty list, so consumers that memoize on it don't redo work per render.
const NO_TEAMS: TeamEntry[] = [];

/** Tell every mounted `useTeams` to re-read the list. Call after anything that
 *  installs or removes a skill — an expert can be installed from the skills
 *  gallery too, and the Experts view and composer pill must not keep counting
 *  a stale list until a reload. */
export function notifyTeamsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * The deployment's installed experts, from `GET ${deploymentUrl}/api/teams`.
 *
 * This is the authority on what is installed: the backend walks the workspace,
 * global and builtin skill tiers, while the Next.js `/api/skills` route only
 * reads the global one. Unlike the model registry this is NOT cached at module
 * level — installing or uninstalling a skill changes it, so the Experts view
 * refetches after every mutation via `refresh`.
 *
 * Failures are non-fatal: an older deployment without the route simply yields
 * an empty list, and the view falls back to what the local scan can see.
 */
export function useTeams(): {
  teams: TeamEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  // Reconnect or a new URL in Settings swaps the deployment without remounting
  // the chat. A switch, a return included, resets the list during render
  // (React drops that render and draws again), so none shows until the
  // deployment answers; a refresh of the same deployment keeps the list up
  // while it re-reads.
  const { deploymentUrl, apiKey } = useDeployment();
  const key = `${deploymentUrl}\n${apiKey}`;
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    // The refresh this list answers; null until the deployment answers.
    revision: number | null;
    teams: TeamEntry[];
    error: string | null;
  }>({ key, revision: null, teams: NO_TEAMS, error: null });
  if (loaded.key !== key) {
    setLoaded({ key, revision: null, teams: NO_TEAMS, error: null });
  }

  const refresh = useCallback(() => notifyTeamsChanged(), []);

  useEffect(() => {
    const onChange = () => setRevision((n) => n + 1);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!deploymentUrl) return;
    let cancelled = false;
    const headers: Record<string, string> = {};
    if (apiKey) headers["X-Api-Key"] = apiKey;
    fetch(`${deploymentUrl.replace(/\/$/, "")}/api/teams`, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parseTeams(await r.json());
      })
      .then((teams) => {
        if (!cancelled) setLoaded({ key, revision, teams, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error =
          err instanceof Error ? err.message : "Failed to load experts.";
        setLoaded({ key, revision, teams: NO_TEAMS, error });
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentUrl, apiKey, key, revision]);

  const { teams, error } = loaded;
  const loading = !!deploymentUrl && loaded.revision !== revision;

  return { teams, loading, error, refresh };
}
