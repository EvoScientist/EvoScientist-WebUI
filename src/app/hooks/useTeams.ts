"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Team } from "@/lib/teams";

interface UseTeamsResult {
  teams: Team[];
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch the catalog of user-summonable teams from `/api/teams`.
 *
 * The catalog is near-static (curated by the backend, one YAML per team, no
 * per-user or per-thread variation) so this hook does NOT poll — it fetches
 * once on mount and exposes an explicit `refresh` for the user-initiated
 * "reload catalog" case. Contrast with `useAsyncAgents`, which polls because
 * it's watching the running-tasks board.
 *
 * The monotonic-request guard (`reqRef`) is the same idiom used by
 * `useAsyncAgents` — protects against a slow response landing after a newer
 * one (e.g. rapid `refresh()` clicks) and clobbering fresh state with stale.
 */
export function useTeams(): UseTeamsResult {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const reqId = ++reqRef.current;
    try {
      const res = await fetch("/api/teams", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET /api/teams -> ${res.status}`);
      const body = (await res.json()) as { teams?: Team[] };
      if (reqId !== reqRef.current || !mountedRef.current) return;
      setTeams(Array.isArray(body.teams) ? body.teams : []);
      setError(null);
    } catch (e) {
      if (reqId === reqRef.current && mountedRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load teams.");
      }
    } finally {
      if (reqId === reqRef.current && mountedRef.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { teams, loaded, error, refresh };
}
