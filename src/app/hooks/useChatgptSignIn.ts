"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsAccess } from "@/app/hooks/useSettings";
import type { DesktopChatgpt } from "@/lib/desktop";
import {
  chatgptFailureText,
  chatgptSignOutFailureText,
} from "@/lib/settingsForm";

export interface ChatgptSignIn {
  phase: "idle" | "signing_in" | "signing_out";
  /** Why the last sign-in or sign-out did not happen; null after a cancel. */
  message: string | null;
  signIn(): Promise<void>;
  cancel(): void;
  signOut(): Promise<void>;
}

/**
 * The desktop app's ChatGPT sign-in for the Settings page and the wizard.
 * The app runs it (the browser page, the token on disk); the page reads the
 * settings again after every answer, as the state shown comes from
 * GET /api/settings. Answers that arrive after the field is gone are dropped.
 */
export function useChatgptSignIn(
  chatgpt: DesktopChatgpt | null
): ChatgptSignIn {
  const { refresh } = useSettingsAccess();
  const [phase, setPhase] = useState<ChatgptSignIn["phase"]>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!chatgpt) return;
    setPhase("signing_in");
    setMessage(null);
    const r = await chatgpt.signIn();
    await refresh().catch(() => {});
    if (!mounted.current) return;
    setPhase("idle");
    setMessage(r.ok ? null : chatgptFailureText(r.code, r.message));
  }, [chatgpt, refresh]);

  const cancel = useCallback(() => {
    void chatgpt?.cancelSignIn();
  }, [chatgpt]);

  const signOut = useCallback(async () => {
    if (!chatgpt) return;
    setPhase("signing_out");
    setMessage(null);
    const r = await chatgpt.signOut();
    await refresh().catch(() => {});
    if (!mounted.current) return;
    setPhase("idle");
    setMessage(r.ok ? null : chatgptSignOutFailureText(r.code, r.message));
  }, [chatgpt, refresh]);

  return { phase, message, signIn, cancel, signOut };
}
