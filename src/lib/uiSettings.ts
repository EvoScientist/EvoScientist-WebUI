"use client";

import { useCallback, useEffect, useState } from "react";

const COLLAPSE_AGENT_ACTIONS_KEY = "evosci.ui.collapseAgentActions";
const AUTO_OPEN_EXPERTS_ON_NEW_CHAT_KEY = "evosci.ui.autoOpenExpertsOnNewChat";

// Same-tab sibling of the browser's `storage` event, which only fires in
// OTHER tabs. When the ConfigDialog toggles a setting, other hook instances
// in the same tab (e.g. `useAutoOpenExpertsOnNewChat` in `page.tsx`
// consumed by `startNewChat`) also need to update their cached state —
// without this custom broadcast, their `useCallback` closures stay stale
// against the change until a full reload.
const UI_SETTING_CHANGED_EVENT = "evosci.ui.setting-changed";

function notifyUiSettingChanged(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(UI_SETTING_CHANGED_EVENT, { detail: { key } })
  );
}

function subscribeUiSetting(key: string, onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key !== key) return;
    onChange();
  };
  const onLocal = (e: Event) => {
    const detail = (e as CustomEvent<{ key?: string }>).detail;
    if (detail?.key !== key) return;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(UI_SETTING_CHANGED_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(UI_SETTING_CHANGED_EVENT, onLocal);
  };
}

function readCollapseAgentActions(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(COLLAPSE_AGENT_ACTIONS_KEY);
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

  // Pick up changes from other tabs AND other hook instances in the same tab
  // (see `subscribeUiSetting` note above for why the custom same-tab event
  // is needed alongside `storage`).
  useEffect(() => {
    return subscribeUiSetting(COLLAPSE_AGENT_ACTIONS_KEY, () =>
      setValueState(readCollapseAgentActions())
    );
  }, []);

  const setValue = useCallback((next: boolean) => {
    setValueState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(COLLAPSE_AGENT_ACTIONS_KEY, String(next));
      notifyUiSettingChanged(COLLAPSE_AGENT_ACTIONS_KEY);
    }
  }, []);

  return { value, setValue };
}

function readAutoOpenExpertsOnNewChat(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(AUTO_OPEN_EXPERTS_ON_NEW_CHAT_KEY);
  if (raw === null) return true; // default: open the Experts panel on new chat
  return raw === "true";
}

/**
 * Whether clicking "New Chat" should auto-open the Experts inspector so the
 * user can pick a team before starting. Default true. Nudges discovery for
 * new users; power users can disable it in Settings. Same storage/sync shape
 * as `useCollapseAgentActions`.
 */
export function useAutoOpenExpertsOnNewChat(): {
  value: boolean;
  setValue: (next: boolean) => void;
} {
  const [value, setValueState] = useState<boolean>(
    readAutoOpenExpertsOnNewChat
  );

  useEffect(() => {
    return subscribeUiSetting(AUTO_OPEN_EXPERTS_ON_NEW_CHAT_KEY, () =>
      setValueState(readAutoOpenExpertsOnNewChat())
    );
  }, []);

  const setValue = useCallback((next: boolean) => {
    setValueState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        AUTO_OPEN_EXPERTS_ON_NEW_CHAT_KEY,
        String(next)
      );
      notifyUiSettingChanged(AUTO_OPEN_EXPERTS_ON_NEW_CHAT_KEY);
    }
  }, []);

  return { value, setValue };
}
