"use client";

import { useEffect, useState } from "react";
import { getConfig } from "@/lib/config";

export interface ModelRegistryEntry {
  /** Short name as the user types in `/model <name>`. */
  name: string;
  /** Provider-specific model id (often equal to `name`). Informational only;
   *  the WebUI doesn't pass it to the run config. */
  model_id: string;
  /** Provider key the backend uses to route the call. */
  provider: string;
}

export interface ModelRegistry {
  entries: ReadonlyArray<ModelRegistryEntry>;
  /** What `/model reset` would land on — the deployment-configured default.
   *  May be null when the backend can't resolve a default (older deployments
   *  without the endpoint, or a config that omitted the key). */
  defaultEntry: { name: string; provider: string | null } | null;
}

interface RegistryResponse {
  entries?: unknown;
  default?: unknown;
}

const EMPTY: ModelRegistry = { entries: [], defaultEntry: null };

/**
 * Fetch the backend's authoritative model registry from
 * `GET ${deploymentUrl}/api/models`. The endpoint is mounted into the
 * langgraph-dev process (see `.backend-ref/notes/expose-available-models-endpoint.md`)
 * so the URL lives on the same origin/port as the SDK, not the WebUI's
 * Next.js server. We fetch once per session and cache in component state —
 * the registry is large (~120 entries) but static between deployment
 * restarts.
 *
 * Failures are non-fatal: the picker falls back to its curated
 * `COMMON_MODELS` list when `entries` is empty.
 */
export function useAvailableModels(): {
  registry: ModelRegistry;
  loading: boolean;
  error: string | null;
} {
  const [registry, setRegistry] = useState<ModelRegistry>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cfg = getConfig();
    if (!cfg) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const apiKey =
      cfg.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
    const headers: Record<string, string> = {};
    if (apiKey) headers["X-Api-Key"] = apiKey;
    fetch(`${cfg.deploymentUrl.replace(/\/$/, "")}/api/models`, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as RegistryResponse;
      })
      .then((body) => {
        if (cancelled) return;
        const entries: ModelRegistryEntry[] = [];
        if (Array.isArray(body.entries)) {
          for (const raw of body.entries) {
            if (!raw || typeof raw !== "object") continue;
            const e = raw as {
              name?: unknown;
              model_id?: unknown;
              provider?: unknown;
            };
            if (
              typeof e.name === "string" &&
              typeof e.provider === "string" &&
              e.name &&
              e.provider
            ) {
              entries.push({
                name: e.name,
                model_id: typeof e.model_id === "string" ? e.model_id : e.name,
                provider: e.provider,
              });
            }
          }
        }
        let defaultEntry: ModelRegistry["defaultEntry"] = null;
        if (body.default && typeof body.default === "object") {
          const d = body.default as { name?: unknown; provider?: unknown };
          if (typeof d.name === "string" && d.name) {
            defaultEntry = {
              name: d.name,
              provider:
                typeof d.provider === "string" && d.provider
                  ? d.provider
                  : null,
            };
          }
        }
        setRegistry({ entries, defaultEntry });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load models.");
        setRegistry(EMPTY);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { registry, loading, error };
}
