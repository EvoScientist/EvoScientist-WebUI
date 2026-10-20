"use client";

import { useEffect } from "react";
import { refreshModelRegistry } from "@/app/hooks/useAvailableModels";
import { notifyTeamsChanged } from "@/app/hooks/useTeams";

/**
 * Reads the deployment's model registry and expert list again. Both can
 * change under the same URL: the backend restarted with other models, an
 * expert was installed from the CLI, or the backend wasn't up when the page
 * loaded. What shows stays until the new answers come.
 */
export function refreshBackendLists(deploymentUrl: string): void {
  refreshModelRegistry(deploymentUrl);
  notifyTeamsChanged();
}

/**
 * Reads both lists again whenever the tab comes back into view. The health
 * light doesn't probe a hidden tab, so a backend restarted meanwhile (say
 * from a terminal) is never seen going down, and its `onOnline` never fires.
 */
export function useBackendListsRefresh(deploymentUrl: string): void {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshBackendLists(deploymentUrl);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [deploymentUrl]);
}
