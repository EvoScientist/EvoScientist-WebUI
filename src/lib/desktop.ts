// The desktop app's bridge (W03d implements it). The WebUI runs in a plain
// browser as well, so every member is feature-detected: a page without the
// bridge gets null, and one with an older bridge gets only what it has.

export type RestartResult =
  | { ok: true }
  /** `not_owned`: the app did not start this backend. */
  | { ok: false; code: string };

export interface DesktopBridge {
  /** Restart the backend the app started. Resolves once the restarted
   *  backend answers again: the page reads the settings right after. */
  restartBackend?: () => Promise<RestartResult>;
  /** The folder the app suggests for new work, e.g. Documents/EvoScientist. */
  defaultFolder?: string;
}

declare global {
  interface Window {
    evoscientistDesktop?: unknown;
  }
}

/** The members of the bridge this page can use, or null in a browser. */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const raw = window.evoscientistDesktop;
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const bridge: DesktopBridge = {};
  if (typeof candidate.restartBackend === "function") {
    const restart = candidate.restartBackend as () => Promise<RestartResult>;
    bridge.restartBackend = () => restart.call(raw);
  }
  if (typeof candidate.defaultFolder === "string" && candidate.defaultFolder) {
    bridge.defaultFolder = candidate.defaultFolder;
  }
  return bridge;
}
