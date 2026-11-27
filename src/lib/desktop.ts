// The desktop app's bridge: backend restart, its folders, a folder dialog,
// its own updates and the ChatGPT sign-in. The WebUI runs in a plain browser as well, so every member
// is feature-detected: a page without the bridge gets null, and one with an
// older bridge gets only what it has.

export type RestartResult =
  | { ok: true }
  /** `not_owned`: the app did not start this backend. `cancelled`: the user
   *  answered Cancel to the app's question. `busy`: the app is launching,
   *  restarting from its menu, running a status-screen action or quitting.
   *  Any other code (`not_allowed`, `internal_error`, `ui_server_exited`, ...)
   *  is a failure. */
  | { ok: false; code: string };

/** The app update the desktop app offers. `failed`: the last download
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
   *  On success the app ends; otherwise `busy`, `cancelled`, `not_ready`
   *  (no downloaded update, or it cannot be opened), `cannot_replace` (macOS:
   *  the app runs from the dmg or sits in a folder the account cannot
   *  change; the app shows a box with the download page), `update_pending`
   *  (macOS still works on an install that was given up), `update_failed`
   *  (the app started again on the current version), `not_allowed`, or
   *  `failed` (no answer the bridge could read). */
  restartToUpdate(): Promise<RestartResult>;
}

/** A sign-in's end. Codes: the core's (`port_in_use`, `timed_out`,
 *  `cancelled`, `sign_in_failed`, `internal_error`), the app's (`busy`,
 *  `not_allowed`), or `failed` (no answer the bridge could read). */
export type ChatgptSignInResult =
  | { ok: true; plan: string | null }
  | { ok: false; code: string; message: string };

/** A sign-out's end: `cancelled` when the user answered Cancel to the
 *  app's question (the token stays), else as for a sign-in. */
export type ChatgptSignOutResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface DesktopChatgpt {
  /** Opens the ChatGPT sign-in in the browser and resolves when it ends; a
   *  call while one runs joins it and opens its page again. */
  signIn(): Promise<ChatgptSignInResult>;
  cancelSignIn(): Promise<void>;
  /** Whether a sign-in runs now; false when the app could not answer.
   *  Missing in an older app. */
  isSigningIn?(): Promise<boolean>;
  /** The end of the sign-in that runs, or null at once when none does (or
   *  the app could not answer). Opens nothing. Missing in an older app. */
  waitForSignIn?(): Promise<ChatgptSignInResult | null>;
  /** Removes the stored sign-in; the app asks first while work runs. */
  signOut(): Promise<ChatgptSignOutResult>;
}

export interface DesktopBridge {
  /** Restart the backend the app started. Resolves once the restarted
   *  backend answers again: the page reads the settings right after. A
   *  bridge that throws or answers another shape reads as
   *  `{ ok: false, code: "failed" }`. */
  restartBackend?: () => Promise<RestartResult>;
  /** The folder the app suggests for new work, e.g. Documents/EvoScientist,
   *  as the OS spells it: it is shown and saved as `default_workdir`. */
  defaultFolder?: string;
  /** The app's folders in the form the core keys projects by (real path when
   *  the folder exists, forward slashes, no trailing slash), to compare with
   *  project keys. Each is missing when the app does not know it. */
  projectFolders?: {
    /** `defaultFolder`. */
    default?: string;
    /** The folder this app registered at launch, the one this page belongs
     *  to (with a reused backend, not the folder that backend started in). */
    launch?: string;
  };
  /** Opens the app's folder dialog at `defaultPath`, else at `defaultFolder`.
   *  Resolves the chosen folder as the OS spells it, or null on a cancel,
   *  while another dialog is open, or when the app fails or answers another
   *  shape. */
  pickFolder?: (defaultPath?: string) => Promise<string | null>;
  /** App updates; missing in an app that does not update itself. */
  appUpdate?: DesktopAppUpdate;
  /** The ChatGPT sign-in; missing in an older app. */
  chatgpt?: DesktopChatgpt;
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

const FAILED = { ok: false as const, code: "failed", message: "" };

/** A failure the app answered, or `failed`. */
function failureOf(r: Record<string, unknown> | null) {
  return typeof r?.code === "string"
    ? {
        ok: false as const,
        code: r.code,
        message: typeof r.message === "string" ? r.message : "",
      }
    : FAILED;
}

function chatgptOf(raw: unknown): DesktopChatgpt | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const { signIn, cancelSignIn, signOut, isSigningIn, waitForSignIn } = c;
  if (
    typeof signIn !== "function" ||
    typeof cancelSignIn !== "function" ||
    typeof signOut !== "function"
  )
    return undefined;
  const record = (v: unknown) =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  const signInResult = (v: unknown): ChatgptSignInResult => {
    const r = record(v);
    if (r?.ok === true)
      return { ok: true, plan: typeof r.plan === "string" ? r.plan : null };
    return failureOf(r);
  };
  const chatgpt: DesktopChatgpt = {
    signIn: async () => {
      try {
        return signInResult(await signIn.call(raw));
      } catch {
        return FAILED;
      }
    },
    cancelSignIn: async () => {
      try {
        await cancelSignIn.call(raw);
      } catch {
        // The app logs it; the sign-in ends on its own.
      }
    },
    signOut: async () => {
      try {
        const r = record(await signOut.call(raw));
        return r?.ok === true ? { ok: true } : failureOf(r);
      } catch {
        return FAILED;
      }
    },
  };
  // Newer than the three above: an older app has neither.
  if (typeof isSigningIn === "function")
    chatgpt.isSigningIn = async () => {
      try {
        return (await isSigningIn.call(raw)) === true;
      } catch {
        return false;
      }
    };
  if (typeof waitForSignIn === "function")
    chatgpt.waitForSignIn = async () => {
      try {
        const r: unknown = await waitForSignIn.call(raw);
        return r === null || r === undefined ? null : signInResult(r);
      } catch {
        return null;
      }
    };
  return chatgpt;
}

declare global {
  interface Window {
    evoscientistDesktop?: unknown;
  }
}

/** The non-empty string folders of `projectFolders`, or undefined when it is
 *  not an object. */
function projectFoldersOf(v: unknown): DesktopBridge["projectFolders"] {
  if (typeof v !== "object" || v === null) return undefined;
  const raw = v as Record<string, unknown>;
  const folders: NonNullable<DesktopBridge["projectFolders"]> = {};
  if (typeof raw.default === "string" && raw.default)
    folders.default = raw.default;
  if (typeof raw.launch === "string" && raw.launch) folders.launch = raw.launch;
  return folders;
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
  const folders = projectFoldersOf(candidate.projectFolders);
  if (folders) bridge.projectFolders = folders;
  if (typeof candidate.pickFolder === "function") {
    const pick = candidate.pickFolder as (defaultPath?: string) => unknown;
    bridge.pickFolder = async (defaultPath) => {
      try {
        const folder = await pick.call(raw, defaultPath);
        return typeof folder === "string" && folder ? folder : null;
      } catch {
        return null;
      }
    };
  }
  const appUpdate = appUpdateOf(candidate.appUpdate);
  if (appUpdate) bridge.appUpdate = appUpdate;
  const chatgpt = chatgptOf(candidate.chatgpt);
  if (chatgpt) bridge.chatgpt = chatgpt;
  return bridge;
}
