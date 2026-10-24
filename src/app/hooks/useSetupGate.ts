"use client";

import { useEffect, useRef, useState } from "react";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { deferSetup, isSetupDeferred } from "@/lib/setupDeferral";
import { createLeaveTracker, SETUP_VIEWS } from "@/lib/setupLeave";
import { useDeployment } from "@/providers/ClientProvider";

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

  // Leaving Setup or Settings while setup is needed is recorded once it is
  // real (setupLeave.ts: a render that still shows the old view, with the
  // address bar already on Setup, is not). The gate below does not wait for
  // it: a page that showed either view has decided.
  const setupNeeded = payload?.setup_needed === true;
  const previousView = useRef(view);
  const latestView = useRef(view);
  const [leaves] = useState(() =>
    createLeaveTracker({
      record: deferSetup,
      viewNow: () => latestView.current,
      urlViewNow: () => new URLSearchParams(window.location.search).get("view"),
    })
  );
  useEffect(() => {
    latestView.current = view;
    if (SETUP_VIEWS.has(view)) leaves.back(deploymentUrl);
    else if (SETUP_VIEWS.has(previousView.current) && setupNeeded) {
      leaves.leave(deploymentUrl);
    }
    previousView.current = view;
  }, [view, setupNeeded, deploymentUrl, leaves]);
  // A reload or an unmount right after Configure later keeps it once the
  // address bar has left Setup: nuqs writes it on the next tick when idle,
  // and a reload before that opens Setup anyway.
  useEffect(() => {
    const flush = () => leaves.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [leaves]);

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
