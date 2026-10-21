"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { useDeployment } from "@/providers/ClientProvider";
import {
  isSettingsPayload,
  settingsWriteAccess,
  type SettingsAccess,
  type SettingsPayload,
  type SettingsWriteAccess,
} from "@/lib/settings";

// SWR shares one request and one cached answer per key between every
// component that calls these hooks (the page, both thread lists, the chat
// notices, the Setup view). The keys carry the deployment URL, so a
// reconnect to another deployment reads that one's settings.

type SettingsKey = readonly ["settings", string, string];

async function fetchSettings([, base, apiKey]: SettingsKey): Promise<
  SettingsPayload | "unsupported"
> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const res = await fetch(`${base}/api/settings`, {
    headers,
    cache: "no-store",
  });
  // Deployments without the route (EvoScientist before C14).
  if (res.status === 404 || res.status === 405) return "unsupported";
  if (!res.ok) throw new Error(`GET /api/settings answered ${res.status}`);
  const body: unknown = await res.json();
  if (!isSettingsPayload(body)) {
    throw new Error("GET /api/settings answered an unexpected body");
  }
  return body;
}

async function fetchAccess(): Promise<SettingsAccess> {
  const res = await fetch("/api/settings/access", { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/settings/access answered ${res.status}`);
  return (await res.json()) as SettingsAccess;
}

export interface UseSettings {
  /** The backend's settings; undefined while loading, on an error and
   *  against a backend without the route. */
  payload: SettingsPayload | undefined;
  /** The backend has no settings route: hide everything settings-related. */
  unsupported: boolean;
  error: Error | undefined;
  isLoading: boolean;
  /** Read the settings again, for example after a save. */
  refresh: () => Promise<unknown>;
}

/** The current deployment's `GET /api/settings`. */
export function useSettings(): UseSettings {
  const { deploymentUrl, apiKey } = useDeployment();
  const base = deploymentUrl ? deploymentUrl.replace(/\/$/, "") : null;
  const key: SettingsKey | null = base ? ["settings", base, apiKey] : null;
  const { data, error, isLoading, mutate } = useSWR(key, fetchSettings);
  return {
    payload: data === "unsupported" ? undefined : data,
    unsupported: data === "unsupported",
    error: error as Error | undefined,
    isLoading,
    refresh: mutate,
  };
}

export interface UseSettingsAccess {
  /** Undefined while still checking. */
  access: SettingsWriteAccess | undefined;
  /** Check again, together with the settings it compares against. */
  refresh: () => Promise<unknown>;
}

/** Whether this page can save the settings it shows (WebUI#55, point 4). */
export function useSettingsAccess(): UseSettingsAccess {
  const { deploymentUrl } = useDeployment();
  const settings = useSettings();
  // Asked once the deployment's settings arrived: an answer from while the
  // backend was still starting would otherwise stay until the next focus.
  const relay = useSWR(
    deploymentUrl && settings.payload
      ? (["settings-access", deploymentUrl] as const)
      : null,
    fetchAccess
  );
  const refreshSettings = settings.refresh;
  const refreshRelay = relay.mutate;
  const refresh = useCallback(
    () => Promise.all([refreshSettings(), refreshRelay()]),
    [refreshSettings, refreshRelay]
  );

  let access: SettingsWriteAccess | undefined;
  if (settings.unsupported) {
    access = { writable: false, reason: "unsupported" };
  } else if (settings.error || relay.error) {
    access = { writable: false, reason: "backend_unreachable" };
  } else if (settings.payload && relay.data) {
    access = settingsWriteAccess(deploymentUrl, relay.data, settings.payload);
  }
  return { access, refresh };
}
