"use client";

import { useEffect, useRef } from "react";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { deferSetup, isSetupDeferred } from "@/lib/setupDeferral";
import { useDeployment } from "@/providers/ClientProvider";

// The views that show EvoScientist's settings: the Settings page (the gear)
// and its first-run entry. The user has seen the fields in either.
const SETUP_VIEWS: ReadonlySet<string | null> = new Set(["setup", "settings"]);

/**
 * First run: open the Setup wizard before the chat when EvoScientist needs
 * setup, its config parses, and this page can save. Decided once per
 * deployment and page load, on the first answers the chat sees. Leaving Setup
 * or Settings while it is still needed is "Configure later": the wizard then
 * stays closed and the chat shows a notice instead.
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

  // Leaving Setup or Settings is recorded first, so the gate below already
  // sees it.
  const setupNeeded = payload?.setup_needed === true;
  const previousView = useRef(view);
  useEffect(() => {
    if (
      SETUP_VIEWS.has(previousView.current) &&
      !SETUP_VIEWS.has(view) &&
      setupNeeded
    ) {
      deferSetup(deploymentUrl);
    }
    previousView.current = view;
  }, [view, setupNeeded, deploymentUrl]);

  const decidedFor = useRef<string | null>(null);
  useEffect(() => {
    // A page that starts on Setup (the desktop app opens `?view=setup`) or
    // Settings has had its wizard.
    if (SETUP_VIEWS.has(view)) decidedFor.current = deploymentUrl;
    // Decided on the first answers the chat sees: a later one (a key removed
    // in a terminal, read again on focus) does not take the chat away.
    if (view !== null || !payload || access === undefined) return;
    if (decidedFor.current === deploymentUrl) return;
    decidedFor.current = deploymentUrl;
    if (!wizardWanted || isSetupDeferred(deploymentUrl)) return;
    void setView("setup");
  }, [wizardWanted, payload, access, view, deploymentUrl, setView]);
}
