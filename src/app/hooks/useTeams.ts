"use client";

import { useCallback, useEffect, useState } from "react";

import { getConfig } from "@/lib/config";
import { parseTeams, type TeamEntry } from "@/lib/teams";

// The Experts view and the chat composer each hold their own instance, and
// the chat stays mounted behind the view. Installing a skill in one must
// refresh the other, or the composer's pill counts a stale list until a
// reload — same cross-component signal the auto-approve and auto-notify
// stores already use.
const CHANGE_EVENT = "evo-teams-change";

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
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => notifyTeamsChanged(), []);

  useEffect(() => {
    const onChange = () => setRevision((n) => n + 1);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  useEffect(() => {
    const cfg = getConfig();
    if (!cfg) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const headers: Record<string, string> = {};
    const apiKey =
      cfg.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
    if (apiKey) headers["X-Api-Key"] = apiKey;

    fetch(`${cfg.deploymentUrl.replace(/\/$/, "")}/api/teams`, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parseTeams(await r.json());
      })
      .then((entries) => {
        if (cancelled) return;
        setTeams(entries);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load experts."
        );
        setTeams([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [revision]);

  return { teams, loading, error, refresh };
}
