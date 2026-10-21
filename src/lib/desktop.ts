// The desktop app's bridge (W03d implements it). The WebUI runs in a plain
// browser as well, so every member is feature-detected: a page without the
// bridge gets null, and one with an older bridge gets only what it has.

export type RestartResult =
  | { ok: true }
  /** `not_owned`: the app did not start this backend. */
  | { ok: false; code: string };

export interface DesktopBridge {
  /** Restart the backend the app started. Resolves once the restarted
   *  backend answers again: the page reads the settings right after. A
   *  bridge that throws or answers another shape reads as
   *  `{ ok: false, code: "failed" }`. */
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
    const restart = candidate.restartBackend as () => unknown;
    // An older or broken app may throw or answer another shape.
    bridge.restartBackend = async () => {
      try {
        const result = (await restart.call(raw)) as {
          ok?: unknown;
          code?: unknown;
        } | null;
        if (result?.ok === true) return { ok: true };
        return {
          ok: false,
          code: typeof result?.code === "string" ? result.code : "failed",
        };
      } catch {
        return { ok: false, code: "failed" };
      }
    };
  }
  if (typeof candidate.defaultFolder === "string" && candidate.defaultFolder) {
    bridge.defaultFolder = candidate.defaultFolder;
  }
  return bridge;
}
