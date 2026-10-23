"use client";

import { useCallback, useEffect, useState } from "react";

const COLLAPSE_AGENT_ACTIONS_KEY = "evosci.ui.collapseAgentActions";
// Same-tab writes: `storage` events fire only in other tabs, and the chat
// stays mounted while Settings changes this. The value rides in the event so
// readers agree even when storage refuses the write.
const CHANGE_EVENT = "evo-collapse-agent-actions-change";

function readCollapseAgentActions(): boolean {
  if (typeof window === "undefined") return true;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COLLAPSE_AGENT_ACTIONS_KEY);
  } catch {
    // Storage is blocked; use the default.
  }
  if (raw === null) return true; // default: collapse
  return raw === "true";
}

/**
 * Whether completed agent-action groups should auto-collapse once a turn
 * settles. Defaults to true. Stored in localStorage so the preference
 * persists across reloads. Standalone from `DeploymentConfig` because this
 * is a UI preference, not a server connection.
 */
export function useCollapseAgentActions(): {
  value: boolean;
  setValue: (next: boolean) => void;
} {
  const [value, setValueState] = useState<boolean>(readCollapseAgentActions);

  // Pick up changes from other tabs / late init (e.g. SSR → CSR transition),
  // and from other readers in this tab.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== COLLAPSE_AGENT_ACTIONS_KEY) return;
      setValueState(readCollapseAgentActions());
    };
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<unknown>).detail;
      if (typeof next === "boolean") setValueState(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const setValue = useCallback((next: boolean) => {
    setValueState(next);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(COLLAPSE_AGENT_ACTIONS_KEY, String(next));
      } catch {
        // Not saved when storage is blocked or full.
      }
      window.dispatchEvent(
        new CustomEvent<boolean>(CHANGE_EVENT, { detail: next })
      );
    }
  }, []);

  return { value, setValue };
}
