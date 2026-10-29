// The desktop app's bridge (W03d implements it, W04 adds `appUpdate`). The WebUI runs in a plain
// browser as well, so every member is feature-detected: a page without the
// bridge gets null, and one with an older bridge gets only what it has.

export type RestartResult =
  | { ok: true }
  /** `not_owned`: the app did not start this backend. `cancelled`: the user
   *  answered Cancel to the app's question. `busy`: the app is launching,
   *  restarting from its menu, running a status-screen action or quitting.
   *  Any other code (`not_allowed`, `internal_error`, `ui_server_exited`, ...)
   *  is a failure. */
  | { ok: false; code: string };

/** The app update the desktop app offers (W04). `failed`: the last download
 *  did not finish. */
export type AppUpdateState =
  | { kind: "none" }
  | { kind: "available"; version: string; failed: boolean }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string };

export interface DesktopAppUpdate {
  /** The current state; `none` when the app answers another shape. */
  state(): Promise<AppUpdateState>;
  /** Calls `cb` on each change; returns the unsubscribe. */
  onState(cb: (s: AppUpdateState) => void): () => void;
  /** "Download": the app downloads only when asked. */
  download(): Promise<void>;
  /** "Restart to update": the app asks first while work runs, as at quit.
   *  On success the app ends; `busy`, `cancelled`, `not_ready` otherwise. */
  restartToUpdate(): Promise<RestartResult>;
}

export interface DesktopBridge {
  /** Restart the backend the app started. Resolves once the restarted
   *  backend answers again: the page reads the settings right after. A
   *  bridge that throws or answers another shape reads as
   *  `{ ok: false, code: "failed" }`. */
  restartBackend?: () => Promise<RestartResult>;
  /** The folder the app suggests for new work, e.g. Documents/EvoScientist. */
  defaultFolder?: string;
  /** App updates (W04); missing in an app that does not update itself. */
  appUpdate?: DesktopAppUpdate;
}

const NONE: AppUpdateState = { kind: "none" };

/** A state the app sent, or `none` when it has another shape. */
export function parseUpdateState(v: unknown): AppUpdateState {
  if (typeof v !== "object" || v === null) return NONE;
  const s = v as Record<string, unknown>;
  const version = typeof s.version === "string" ? s.version : null;
  if (s.kind === "none") return NONE;
  if (!version) return NONE;
  if (s.kind === "available")
    return { kind: "available", version, failed: s.failed === true };
  if (s.kind === "downloading")
    return {
      kind: "downloading",
      version,
      percent:
        typeof s.percent === "number" && Number.isFinite(s.percent)
          ? Math.max(0, Math.min(100, Math.floor(s.percent)))
          : 0,
    };
  if (s.kind === "ready") return { kind: "ready", version };
  return NONE;
}

/** Reads a restart's answer; anything else reads as `failed`. */
function restartResult(result: unknown): RestartResult {
  const r = result as { ok?: unknown; code?: unknown } | null;
  if (r?.ok === true) return { ok: true };
  return {
    ok: false,
    code: typeof r?.code === "string" ? r.code : "failed",
  };
}

function appUpdateOf(raw: unknown): DesktopAppUpdate | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const { state, onState, download, restartToUpdate } = u;
  if (
    typeof state !== "function" ||
    typeof onState !== "function" ||
    typeof download !== "function" ||
    typeof restartToUpdate !== "function"
  )
    return undefined;
  return {
    state: async () => {
      try {
        return parseUpdateState(await state.call(raw));
      } catch {
        return NONE;
      }
    },
    onState: (cb) => {
      try {
        const off = onState.call(raw, (s: unknown) => cb(parseUpdateState(s)));
        return typeof off === "function" ? () => void off() : () => {};
      } catch {
        return () => {};
      }
    },
    download: async () => {
      try {
        await download.call(raw);
      } catch {
        // The app logs it; the state does not change.
      }
    },
    restartToUpdate: async () => {
      try {
        return restartResult(await restartToUpdate.call(raw));
      } catch {
        return { ok: false, code: "failed" };
      }
    },
  };
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
        return restartResult(await restart.call(raw));
      } catch {
        return { ok: false, code: "failed" };
      }
    };
  }
  if (typeof candidate.defaultFolder === "string" && candidate.defaultFolder) {
    bridge.defaultFolder = candidate.defaultFolder;
  }
  const appUpdate = appUpdateOf(candidate.appUpdate);
  if (appUpdate) bridge.appUpdate = appUpdate;
  return bridge;
}
