"use client";

import { useEffect, useState } from "react";
import { useDeployment } from "@/providers/ClientProvider";

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

// Module-level cache keyed by normalised deploymentUrl and API key, so
// remounting ChatInterface or switching back in Settings doesn't ask again. The registry changes only when its backend restarts;
// `refreshModelRegistry` drops a deployment's entries when the page has reason
// to think it did. Failed fetches are evicted so the next read retries.
const cache = new Map<string, Promise<ModelRegistry>>();

const CHANGE_EVENT = "evo-models-change";

/**
 * Drops what this page has read from a deployment's `/api/models`, under every
 * key, and makes every mounted reader ask again; readers keep showing what
 * they have until the new answer comes. For a backend that may have changed
 * under the same URL: see `refreshBackendLists`, and Reconnect in page.tsx.
 */
export function refreshModelRegistry(deploymentUrl: string): void {
  const prefix = `${deploymentUrl.replace(/\/$/, "")}\n`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

function fetchRegistry(
  deploymentUrl: string,
  apiKey: string
): Promise<ModelRegistry> {
  const url = deploymentUrl.replace(/\/$/, "");
  // A request sent with another key isn't this key's answer.
  const key = `${url}\n${apiKey}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;

  const p = fetch(`${url}/api/models`, { headers })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as RegistryResponse;
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
              typeof d.provider === "string" && d.provider ? d.provider : null,
          };
        }
      }
      return { entries, defaultEntry } as ModelRegistry;
    })
    .catch((err: unknown) => {
      // A refresh may have replaced this request; leave the newer one.
      if (cache.get(key) === p) cache.delete(key);
      throw err;
    });

  cache.set(key, p);
  return p;
}

/**
 * Fetch the backend's authoritative model registry from
 * `GET ${deploymentUrl}/api/models`. Results are cached at module level —
 * the registry is static between deployment restarts, so remounting
 * ChatInterface never triggers a redundant network request.
 *
 * Failures are non-fatal: the picker falls back to its curated
 * `COMMON_MODELS` list when `entries` is empty. Failed fetches are evicted
 * from the cache, so the next mount, a switch back or a refresh reads again.
 */
export function useAvailableModels(): {
  registry: ModelRegistry;
  loading: boolean;
  error: string | null;
} {
  // Reconnect or a new URL in Settings swaps the deployment without remounting
  // the chat, so the registry follows the client's deployment. A switch, a
  // return included, resets it during render: React drops that render and
  // draws again, so nothing of the last deployment's shows.
  const { deploymentUrl, apiKey } = useDeployment();
  const key = `${deploymentUrl}\n${apiKey}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    registry: ModelRegistry | null;
    error: string | null;
  }>({ key, registry: null, error: null });
  if (loaded.key !== key) {
    setLoaded({ key, registry: null, error: null });
  }
  // Bumped by refreshModelRegistry; the registry shown stays until the
  // re-read answers.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const onChange = () => setRevision((n) => n + 1);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!deploymentUrl) return;
    let cancelled = false;
    fetchRegistry(deploymentUrl, apiKey)
      .then((registry) => {
        if (!cancelled) setLoaded({ key, registry, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error =
          err instanceof Error ? err.message : "Failed to load models.";
        setLoaded({ key, registry: EMPTY, error });
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentUrl, apiKey, key, revision]);

  return {
    registry: loaded.registry ?? EMPTY,
    loading: !!deploymentUrl && !loaded.registry,
    error: loaded.error,
  };
}
