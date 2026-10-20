"use client";

import { useEffect, useRef } from "react";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { deferSetup, isSetupDeferred } from "@/lib/setupDeferral";
import { useDeployment } from "@/providers/ClientProvider";

/**
 * First run: open the Setup wizard before the chat, once per deployment and
 * page load, when EvoScientist needs setup, its config parses, and this page
 * can save. Leaving Setup while it is still needed is "Configure later": the
 * wizard then stays closed and the chat shows a notice instead.
 */
export function useSetupGate(
  view: string | null,
  setView: (view: string | null) => unknown
): void {
  const { deploymentUrl } = useDeployment();
  const { payload } = useSettings();
  const { access } = useSettingsAccess();
  const wizardWanted =
    payload?.setup_needed === true &&
    !payload.config_error &&
    access?.writable === true;

  // Leaving Setup is recorded first, so the gate below already sees it.
  const setupNeeded = payload?.setup_needed === true;
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === "setup" && view !== "setup" && setupNeeded) {
      deferSetup(deploymentUrl);
    }
    previousView.current = view;
  }, [view, setupNeeded, deploymentUrl]);

  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    // A page that starts on Setup (the desktop app opens `?view=setup`)
    // has had its wizard.
    if (view === "setup") openedFor.current = deploymentUrl;
    if (!wizardWanted || view !== null) return;
    if (openedFor.current === deploymentUrl) return;
    openedFor.current = deploymentUrl;
    if (isSetupDeferred(deploymentUrl)) return;
    void setView("setup");
  }, [wizardWanted, view, deploymentUrl, setView]);
}
