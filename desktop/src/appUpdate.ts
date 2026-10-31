// Updates of the app itself, from this repository's GitHub Releases through
// electron-updater (not `update.ts`, which updates the core). The app checks
// on its own and downloads and installs only when the user asks:
// - a check about 5 s after the first page load, then every hour; skipped
//   while offline, while a download runs or once one is ready; a check
//   downloads nothing (`autoDownload` is off);
// - "Download" starts the download; "Restart to update" (app.ts, after the
//   busy checks and the stops) calls `install()`;
// - an update is never installed on quit or at the end of the session
//   (`autoInstallOnAppQuit` is off, and nothing else calls `install()`);
// - a check without an answer within 60 s, and a download that receives no
//   data for 60 s, fail: Electron's network stack never fires the updater's
//   own idle timeout. A failure is only logged; the next check tries again
//   (the updater would hand a stalled check to every later one, so the limit
//   drops it there too). A cut download fails the updater's SHA-512 check;
//   it is never "ready";
// - "Restart to update" starts the installer only when the downloaded file
//   can still be opened (an antivirus may have removed it); otherwise the
//   download is offered again. The updater quits the app as soon as it has
//   asked for the installer, so a start that fails after that is not seen.
import { closeSync, openSync } from "node:fs";
import type { CancellationToken } from "electron-updater";
import type { Logger } from "./proc";

export const FIRST_CHECK_MS = 5_000;
export const CHECK_INTERVAL_MS = 60 * 60_000;
export const CHECK_LIMIT_MS = 60_000;
export const STALL_MS = 60_000;

/** What the app offers, as both pages show it. `failed`: the last download
 *  did not finish. */
export type UpdateState =
  | { kind: "none" }
  | { kind: "available"; version: string; failed: boolean }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string };

/** The part of electron-updater's updater the app uses. */
export interface Updater {
  checkForUpdates(): Promise<{
    isUpdateAvailable: boolean;
    updateInfo: { version: string };
  } | null>;
  /** Resolves with the downloaded files, the installer first. */
  downloadUpdate(token: CancellationToken): Promise<string[]>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(
    event: "download-progress",
    listener: (p: { percent: number }) => void
  ): unknown;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface UpdateDeps {
  updater: Updater;
  newToken(): CancellationToken;
  online(): boolean;
  log: Logger;
  onChange(state: UpdateState): void;
  timers?: Timers;
  stallMs?: number;
  checkLimitMs?: number;
  /** Whether the downloaded installer can be opened. */
  canOpen?(path: string): boolean;
}

export interface AppUpdate {
  readonly state: UpdateState;
  /** Schedules the first check and the hourly ones; once. */
  start(): void;
  /** One check now (skipped when it does not apply). */
  check(): Promise<void>;
  /** "Download": only while an update is offered. */
  download(): void;
  /** Whether a downloaded update can be installed now: one is ready and its
   *  installer can be opened. When the file is gone, the download is offered
   *  again (and false returned). */
  installable(): boolean;
  /** Starts the installer of a downloaded update; false when none is ready
   *  or its file cannot be opened. The caller has stopped everything and lets
   *  the app quit. */
  install(): boolean;
  /** Stops the timers (the app quits). */
  stop(): void;
}

/** An updater error for the log: its first lines, without the response
 *  headers electron-updater appends to an HTTP error. */
export function brief(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const lines = text.split("\n").map((l) => l.trim());
  const end = lines.findIndex((l) => l.startsWith("Headers:"));
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

function canOpenFile(path: string): boolean {
  try {
    closeSync(openSync(path, "r"));
    return true;
  } catch {
    return false;
  }
}

/** electron-updater keeps a running check and returns it to every later
 *  call; after the limit that check is forgotten so the next one asks again.
 *  A private field (6.x): the feed test fails if it goes away. */
function forgetPendingCheck(updater: Updater): void {
  const u = updater as unknown as { checkForUpdatesPromise?: unknown };
  if ("checkForUpdatesPromise" in u) u.checkForUpdatesPromise = null;
}

export function createAppUpdate(deps: UpdateDeps): AppUpdate {
  const { updater, log } = deps;
  const timers = deps.timers ?? realTimers;
  const stallMs = deps.stallMs ?? STALL_MS;
  const checkLimitMs = deps.checkLimitMs ?? CHECK_LIMIT_MS;
  const canOpen = deps.canOpen ?? canOpenFile;

  let state: UpdateState = { kind: "none" };
  let started = false;
  let firstTimer: unknown = null;
  let interval: unknown = null;
  /** The running check's number; a later answer for another one is dropped. */
  let checking: number | null = null;
  let checks = 0;
  /** The running download, with its watchdog. */
  let download: { token: CancellationToken; watchdog: unknown } | null = null;
  /** The installer of the update that is ready. */
  let installer: string | null = null;

  /** A download runs or is ready: checks leave the state alone. */
  const busy = (): boolean =>
    state.kind === "downloading" || state.kind === "ready";

  function set(next: UpdateState): void {
    state = next;
    deps.onChange(state);
  }

  updater.on("download-progress", (p) => {
    if (!download || state.kind !== "downloading") return;
    armWatchdog();
    const percent = Math.max(0, Math.min(100, Math.floor(p.percent)));
    if (percent !== state.percent) set({ ...state, percent });
  });

  function armWatchdog(): void {
    if (!download) return;
    const current = download;
    if (current.watchdog !== null) timers.clearTimeout(current.watchdog);
    current.watchdog = timers.setTimeout(() => {
      if (download !== current) return;
      log.warn(
        `update download: no data for ${Math.round(
          stallMs / 1000
        )} s, cancelled`
      );
      current.token.cancel();
      finishDownload(false);
    }, stallMs);
  }

  function finishDownload(ok: boolean, file: string | null = null): void {
    const current = download;
    if (!current) return;
    if (current.watchdog !== null) timers.clearTimeout(current.watchdog);
    download = null;
    if (state.kind !== "downloading") return;
    installer = ok ? file : null;
    set(
      ok
        ? { kind: "ready", version: state.version }
        : { kind: "available", version: state.version, failed: true }
    );
  }

  async function check(): Promise<void> {
    if (checking !== null || busy()) return;
    if (!deps.online()) {
      log.info("update check skipped: offline");
      return;
    }
    const id = ++checks;
    checking = id;
    const limit = timers.setTimeout(() => {
      if (checking !== id) return;
      checking = null;
      forgetPendingCheck(updater);
      log.warn(
        `update check: no answer in ${Math.round(checkLimitMs / 1000)} s`
      );
    }, checkLimitMs);
    try {
      const r = await updater.checkForUpdates();
      // A download may have started while an offer was showing.
      if (checking !== id || busy()) return;
      if (r?.isUpdateAvailable) {
        const version = r.updateInfo.version;
        log.info(`update check: ${version} available`);
        if (state.kind !== "available" || state.version !== version)
          set({ kind: "available", version, failed: false });
      } else {
        log.info("update check: no update");
        if (state.kind !== "none") set({ kind: "none" });
      }
    } catch (e) {
      if (checking === id) log.warn(`update check failed: ${brief(e)}`);
    } finally {
      if (checking === id) checking = null;
      timers.clearTimeout(limit);
    }
  }

  function installable(): boolean {
    if (state.kind !== "ready") return false;
    if (installer && canOpen(installer)) return true;
    log.warn(
      `update install: the downloaded installer cannot be opened (${
        installer ?? "no file"
      }); offering the download again`
    );
    installer = null;
    set({ kind: "available", version: state.version, failed: true });
    return false;
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (started) return;
      started = true;
      firstTimer = timers.setTimeout(() => void check(), FIRST_CHECK_MS);
      interval = timers.setInterval(() => void check(), CHECK_INTERVAL_MS);
    },
    check,
    download() {
      if (state.kind !== "available" || download) return;
      const version = state.version;
      log.info(`update download: ${version}`);
      const token = deps.newToken();
      const current = { token, watchdog: null as unknown };
      download = current;
      set({ kind: "downloading", version, percent: 0 });
      armWatchdog();
      updater.downloadUpdate(token).then(
        (files) => {
          if (download !== current) return;
          log.info(`update download: ${version} ready`);
          finishDownload(true, files[0] ?? null);
        },
        (e: unknown) => {
          if (download !== current) return;
          log.warn(`update download failed: ${brief(e)}`);
          finishDownload(false);
        }
      );
    },
    installable,
    install() {
      if (!installable() || state.kind !== "ready") return false;
      log.info(`update install: ${state.version}`);
      updater.quitAndInstall(false, true);
      return true;
    },
    stop() {
      if (firstTimer !== null) timers.clearTimeout(firstTimer);
      if (interval !== null) timers.clearInterval(interval);
      firstTimer = interval = null;
    },
  };
}
