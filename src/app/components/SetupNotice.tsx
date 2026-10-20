"use client";

// The notice above the chat when EvoScientist cannot run as configured: the
// selected provider lacks a key or base URL (`setup_needed`), or config.yaml
// does not parse (`config_error`). Where this page can save, it links to the
// Setup view; elsewhere it says to configure the machine that runs
// EvoScientist, and why this page cannot.

import { TriangleAlert } from "lucide-react";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";
import { readOnlyReason } from "@/lib/settingsForm";

export function SetupNotice({ onOpenSetup }: { onOpenSetup: () => void }) {
  const { payload } = useSettings();
  const { access } = useSettingsAccess();
  if (!payload || access === undefined) return null;

  let text: string;
  if (payload.config_error) {
    text = `config.yaml cannot be read (${payload.config_error.path}): ${payload.config_error.detail}. EvoScientist runs on its defaults until the file is fixed.`;
  } else if (payload.setup_needed) {
    text = access.writable
      ? "EvoScientist is not set up yet: the selected provider has no key or address."
      : `EvoScientist is not set up yet. Configure it on the machine that runs it, with EvoSci onboard or the WebUI there. ${
          readOnlyReason(access) ?? ""
        }`;
  } else {
    return null;
  }

  return (
    <div
      role="status"
      className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <span className="flex items-start gap-1.5">
        <TriangleAlert
          className="mt-px size-3.5 shrink-0"
          aria-hidden="true"
        />
        {text.trim()}
      </span>
      {access.writable && (
        <button
          type="button"
          onClick={onOpenSetup}
          className="shrink-0 rounded px-2 py-1 font-semibold transition-colors hover:bg-amber-200 focus-visible:ring-2 focus-visible:ring-amber-700 dark:hover:bg-amber-900"
        >
          Open Setup
        </button>
      )}
    </div>
  );
}
