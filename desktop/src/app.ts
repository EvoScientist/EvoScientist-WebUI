// The desktop app's controller: the state and the flows of the main process
// (launch with install, repair and setup, the UI server, restart backend,
// quit, the end of the session, the status page's actions), with Electron and the processes behind injected
// dependencies so they can be tested without either. main.ts builds the
// dependencies and wires Electron's events to the methods here.
import type { MessageBoxOptions } from "electron";
import { dirname, join } from "node:path";
import {
  boot,
  defaultFolder,
  type BootError,
  type BootOptions,
  type BootState,
  type Manifest,
} from "./boot";
import {
  confirmation,
  workStartedSince,
  type MemoryWaitResult,
  type StopPurpose,
  type WorkCheck,
} from "./closeCheck";
import { FATAL_CODES, type CrashInfo } from "./crash";
import type { DeploySession } from "./deploy";
import type { InstallRun } from "./install";
import type { UiRecord } from "./leftover";
import type { DeployReady, VersionInfo } from "./lines";
import type { Located } from "./locate";
import type { Lookup } from "./release";
import {
  DEFAULT_BACKEND_PORT,
  withReadyFolders,
  type Env,
  type Folders,
  type StartConfig,
} from "./paths";
import type { Collected, Logger } from "./proc";
import { SessionEnd } from "./sessionEnd";
import type { SetupRun, Stage } from "./setup";
import {
  errorScreen,
  installScreen,
  mirrorQuestion,
  progressScreen,
  separateInstallQuestion,
  setupScreen,
  updateQuestion,
  updateOffer,
  updateScreen,
  type ActionId,
  type UpdateOffer,
  type ErrorScreen,
  type Screen,
} from "./screens";
import type { UiServer } from "./uiServer";
import type { AppUpdate, UpdateState } from "./appUpdate";
import type { UpdateRun, UpdateView } from "./update";

/** How long the UI server gets to answer `/` after it starts. */
export const UI_START_MS = 60_000;
/** The install script's lines and setup's stages reach the status page at
 *  most this often. */
export const SCREEN_INTERVAL_MS = 100;

/** The log files as the controller uses them (FileLog). */
export interface AppLog extends Logger {
  readonly path: string;
  readonly folder: string;
  moveTo(dir: string): void;
  close(): void;
}

/** The main window, as far as the controller drives it. */
export interface AppWindow {
  /** Loads the static status page, which then asks for the screen. */
  loadStatusPage(): Promise<void>;
  /** Sends a screen to the status page that is already loaded. */
  sendScreen(s: Screen): void;
  loadUrl(url: string): Promise<void>;
  /** The page the window shows or is loading. */
  currentUrl(): string;
  /** Restores, shows and focuses the window (a second launch). */
  bringToFront(): void;
  focus(): void;
  /** Hides every visible window of the app, the ones the UI opened too, and
   *  returns a function that shows them again. */
  hideAll(): () => void;
  /** Sends the app update's state to the page shown (W04): the WebUI's
   *  bridge reads `state`, the status page `offer`. */
  sendUpdate(state: UpdateState, offer: UpdateOffer | null): void;
}

export interface AppDeps {
  appVersion: string;
  platform: NodeJS.Platform;
  /** The app's own environment (`process.env`). */
  env: Env;
  manifest: Manifest;
  /** The fixed UI port from package.json. */
  uiPort: number;
  folders: Folders;
  /** The environment of every `EvoSci` child (folderEnv). */
  childEnv: NodeJS.ProcessEnv;
  /** Where `langgraph_dev.log` is before `ready` names it. */
  runtimeDir: string;
  /** The bundled WebUI's `server.js` and the entry script that runs it. */
  uiServerJs: string;
  uiEntry: string;
  /** Electron's binary, which runs the UI server as Node. */
  execPath: string;
  /** The bundled WebUI's version, read again for each crash report: when the
   *  bundle cannot be read (a missing server.js), the manifest's uiVersion has
   *  fallen back to the app's version. */
  bundledUiVersion(): string | null;
  log: AppLog;
  uiLog: AppLog;

  // Electron
  messageBox(opts: MessageBoxOptions): Promise<{ response: number }>;
  /** A native folder dialog; null when cancelled. */
  chooseFolder(title: string): Promise<string | null>;
  openPath(path: string): void;
  showItemInFolder(path: string): void;
  copyText(text: string): void;
  documentsDir(): string;
  /** Ends the process, after a relaunch when asked. */
  exit(relaunch: boolean): void;

  // Files
  fileExists(path: string): boolean;
  ensureDir(path: string): void;
  recordEvoSci(found: Located): void;
  readUiRecord(): UiRecord | null;
  writeUiRecord(record: UiRecord | null): void;
  writeCrashReport(dir: string, info: CrashInfo): string | null;
  readStartConfig(): StartConfig;

  // Processes
  locateEvoSci(): Promise<Located | null>;
  runCollect(
    file: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<Collected>;
  startDeploy(evosci: string, workspace: string): DeploySession;
  pickUiPort(preferred: number): Promise<{ port: number; fallback: boolean }>;
  startUiServer(opts: {
    execPath: string;
    entryScript: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    port: number;
    log: Logger;
  }): UiServer;
  uiServerEnv(target: {
    uiPort: number;
    backendUrl: string;
    dataDir: string;
    configDir: string;
    serverJs: string;
  }): NodeJS.ProcessEnv;
  stopLeftoverUi(record: UiRecord | null): Promise<unknown>;
  processStartTime(pid: number): Promise<string | null>;

  // The backend
  checkWork(url: string): Promise<WorkCheck>;
  waitForMemoryWorkers(
    url: string,
    cancelled: () => boolean
  ): Promise<MemoryWaitResult>;

  // Install, repair and setup (W03b)
  keptMirror(): boolean | null;
  keepMirror(cn: boolean): void;
  windowsArm64(): Promise<boolean>;
  updateLockHeld(): boolean;
  backupConfig(): string | null;
  runInstall(cn: boolean, onLine: (line: string) => void): InstallRun;
  runSetup(
    evosci: string,
    cn: boolean,
    stages: Stage[],
    onUpdate: (stages: Stage[]) => void
  ): SetupRun;
  readSetupRecord(): string | null;
  writeSetupRecord(coreVersion: string | null): void;
  pause?(ms: number): Promise<void>;

  // Core updates (W03c)
  /** The newest core release inside the range (Electron's `net.fetch`). */
  lookupRelease(cn: boolean): Promise<Lookup>;
  runUpdate(
    evosci: string,
    version: string,
    stages: Stage[],
    onUpdate: (view: UpdateView) => void
  ): UpdateRun;
  /** Whether a backend answers `/ok` with 200 on this loopback port. */
  backendAnswers(port: number): Promise<boolean>;
  uvToolEnvExists(): Promise<boolean | null>;

  sessionEnd?: SessionEnd;

  // App updates (W04): null where the app does not update itself (not
  // packaged, or not on Windows).
  appUpdate?: AppUpdate | null;
  /** Resolves when the installer had its time to end the app; default 15 s. */
  installWait?(): Promise<void>;
  /** The user cancelled a quit the installer asked for (D12): leaves the
   *  marker the installer waits for (installer/check-app-running.nsh). */
  installQuitCancelled?(): void;
}

/** The argument the installer starts the app with to ask a running app to
 *  quit before it replaces files (installer/check-app-running.nsh). */
export const QUIT_FOR_INSTALL = "--quit-for-install";
/** The file in userData that tells the installer the quit was cancelled. */
export const QUIT_FOR_INSTALL_CANCELLED = "quit-for-install-cancelled";

export type QuitState = "none" | "checking" | "waiting" | "stopping";

/** What the bridge's `restartBackend()` answers the page (W01's
 *  `src/lib/desktop.ts`): `not_owned` for a reused backend, `cancelled` when
 *  the user cancelled a busy check, `busy` while a launch, a restart from the
 *  menu, a screen action or a quit runs or when a quit or the end of the
 *  session starts during the restart, else the code of the error screen the
 *  restart showed (`internal_error` for an exception, `ui_server_exited` when
 *  only the UI server failed). */
export type RestartResult = { ok: true } | { ok: false; code: string };

/** Launch phases that a restart from the page keeps off the window: the page
 *  stays until the backend is back or something needs the status page. */
const QUIET_PHASES: ReadonlySet<BootState["phase"]> = new Set([
  "checking_core",
  "preparing_node",
  "starting_backend",
]);

export interface App {
  attachWindow(w: AppWindow): void;
  /** Shows the first screen and starts the launch. */
  start(): void;
  launch(): Promise<void>;
  restartBackend(): Promise<void>;
  /** The bridge's restart (W03d), for the WebUI's settings page. */
  restartFromPage(): Promise<RestartResult>;
  /** "Restart to update" (W04): busy checks and stops as at quit, then the
   *  installer of the downloaded update. `not_ready` without one, `busy`
   *  while a launch, restart, install, setup, core update or quit runs,
   *  `cancelled` on Cancel. On success the app ends. */
  restartToUpdate(): Promise<RestartResult>;
  /** The app update's state changed: tells the page shown. */
  updateChanged(state: UpdateState): void;
  /** The app update for the WebUI page from `senderOrigin` or the status
   *  page (`statusPage`); any other page gets nothing and starts nothing
   *  (`not_allowed`). */
  updateFor(senderOrigin: string | null, statusPage: boolean): UpdateState;
  updateOfferFor(statusPage: boolean): UpdateOffer | null;
  downloadUpdateFor(senderOrigin: string | null, statusPage: boolean): void;
  restartToUpdateFor(
    senderOrigin: string | null,
    statusPage: boolean
  ): Promise<RestartResult>;
  requestQuit(): Promise<void>;
  act(id: ActionId, arg: unknown): Promise<void>;
  /** The renderer or the preload is broken: a native dialog instead. */
  nativeError(code: string, message: string): Promise<void>;
  crashReport(code: string, message: string, detail?: unknown): string | null;
  /** A second launch; `forInstall` when the installer asks the app to quit
   *  (`--quit-for-install`). */
  secondInstance(forInstall?: boolean): void;
  querySessionEnd(reasons: string[]): void;
  endOfSession(why: string): void;
  /** The current screen, for `status:get`. */
  readonly screen: Screen;
  /** The UI's origin while a UI server runs. */
  uiOrigin(): string | null;
  /** The backend URL for the preload of a page from `senderOrigin` (D6). */
  backendUrlFor(senderOrigin: string | null): string | null;
  /** The bridge's `defaultFolder` for a page from `senderOrigin`: null for
   *  another origin, or when the Documents folder cannot be resolved. */
  defaultFolderFor(senderOrigin: string | null): string | null;
  /** The bridge's `restartBackend()` for a page from `senderOrigin`; another
   *  origin gets `not_allowed` and restarts nothing. */
  restartFor(senderOrigin: string | null): Promise<RestartResult>;
  /** True once the app exits: close and quit events go through. */
  readonly exiting: boolean;
  readonly quitState: QuitState;
}

const INSTALL_WAIT_MS = 15_000;
const defaultInstallWait = () =>
  new Promise<void>((r) => setTimeout(r, INSTALL_WAIT_MS).unref?.());

/** Builds the controller; main.ts attaches the window and calls `start()`. */
export function createApp(deps: AppDeps): App {
  const { log, uiLog, folders } = deps;
  const sessionEnd = deps.sessionEnd ?? new SessionEnd();

  let win: AppWindow | null = null;
  let screen: Screen = progressScreen({ phase: "checking_core" });
  let onStatusPage = false;
  let evosci: string | null = null;
  let core: VersionInfo | null = null;
  let startConfig: StartConfig | null = null;
  /** The current `deploy` process, from its start on (also before `ready`). */
  let session: DeploySession | null = null;
  let ready: DeployReady | null = null;
  let ui: UiServer | null = null;
  /** The backend URL the running UI server was started with. */
  let uiBackendUrl: string | null = null;
  /** The window shows the UI (not the status page). */
  let showingUi = false;
  /** The UI page the window showed or was loading before a status screen
   *  replaced it, and the folder it belongs to: Retry and Restart backend
   *  bring the user back to it. */
  let lastUiUrl: string | null = null;
  let lastUiWorkspace: string | null = null;
  /** A launch, restart or action on the error screen is running. */
  let working = false;
  let quitState: QuitState = "none";
  let quitCancelled = false;
  /** A backend loss or UI server exit that came while a quit was being
   *  decided; shown if the quit is cancelled. */
  let heldError: BootError | null = null;
  /** The stop of a `deploy` that a restart or relaunch already let go of; a
   *  quit waits for it. */
  let stoppingDeploy: Promise<"stopped" | "killed"> | null = null;
  let relaunchAfterExit = false;
  /** The running quit was asked for by the installer (D12). */
  let quitForInstall = false;
  let exiting = false;
  /** The install script, setup or `EvoSci update` while it runs: closing
   *  asks, then stops the script or setup (D14) or waits for the update,
   *  which is never killed (D21). */
  let step: {
    kind: "install" | "setup" | "update";
    cancel(): Promise<void>;
    /** The update waits for processes. */
    waiting?(): boolean;
    /** Cancels the update while it waits, now or later. */
    cancelWhenWaiting?(): boolean;
    /** Cancels the update only while it waits now. */
    cancelNow?(): boolean;
  } | null = null;
  /** Answers the mirror question on the screen. */
  let answerMirror: ((cn: boolean) => void) | null = null;
  /** Answers the update offer or the separate-install question. */
  let answerUpdate: (() => void) | null = null;
  /** The running update's latest view, and whether a quit waits for it. */
  let updateView: UpdateView | null = null;
  let quitAfterUpdate = false;
  /** "Retry with mainland China mirrors" holds for the rest of this session:
   *  a later plain Retry uses them too, also over `mirror: default` in
   *  config.yaml, which only a setup with `--cn` changes. */
  let preferCn = false;
  /** "Continue" after a failed setup holds for the rest of this session too
   *  (Restart backend, Retry), except after a fresh install. */
  let skipSetup = false;
  /** A restart from the page runs: its quiet phases leave the page shown. */
  let pageRestart = false;
  /** The code of the error screen shown last; a restart from the page
   *  clears it first and answers with it. */
  let shownError: string | null = null;
  let pendingScreen: Screen | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = 0;
  const pause =
    deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** The running UI server's origin: links to it stay in the app. */
  const uiOrigin = (): string | null => (ui ? new URL(ui.url).origin : null);
  /** A page from the running UI server (the only one the bridge serves). */
  const fromUi = (senderOrigin: string | null): boolean => {
    const origin = uiOrigin();
    return origin !== null && senderOrigin === origin;
  };

  // --- Screens ------------------------------------------------------------------

  function showScreen(s: Screen): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingScreen = null;
    }
    screen = s;
    // Only an http page counts: a load still in progress never records the
    // status page.
    if (showingUi && win) {
      const page = win.currentUrl();
      if (page.startsWith("http")) lastUiUrl = page;
    }
    showingUi = false;
    if (!win) return;
    if (onStatusPage) {
      win.sendScreen(s);
      return;
    }
    onStatusPage = true;
    win.loadStatusPage().catch((e) => log.warn(`status page: ${e}`));
  }

  /** Shows a screen that changes with every output line (install, setup) at
   *  most every SCREEN_INTERVAL_MS; the latest one wins. */
  function showSoon(s: Screen): void {
    pendingScreen = s;
    if (pendingTimer) return;
    const wait = Math.max(0, lastSent + SCREEN_INTERVAL_MS - Date.now());
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const next = pendingScreen;
      pendingScreen = null;
      if (!next) return;
      lastSent = Date.now();
      showScreen(next);
    }, wait);
  }

  /** The screen for a launch phase; none for the end phases. */
  function onBootState(state: BootState): void {
    switch (state.phase) {
      case "ready":
      case "error":
      case "asking_mirror":
      case "asking_update":
        return;
      case "installing":
        return showSoon(installScreen(state));
      case "updating":
        updateView = state.view;
        return showSoon(updateScreen(state.view, quitAfterUpdate));
      case "setting_up":
        // Before `setup --manifest` answers there is no stage list yet.
        return state.stages.length > 0
          ? showSoon(setupScreen(state.stages))
          : showScreen(progressScreen(state));
      default:
        if (pageRestart && showingUi && QUIET_PHASES.has(state.phase)) return;
        return showScreen(progressScreen(state));
    }
  }

  /** Keeps the install script or setup while it runs, for the close question. */
  function track<R extends InstallRun | SetupRun>(
    kind: "install" | "setup",
    r: R
  ): R {
    const current = { kind, cancel: r.cancel };
    step = current;
    void r.done.finally(() => {
      if (step === current) step = null;
    });
    return r;
  }

  /** Keeps `EvoSci update` while it runs: closing waits for its terminal
   *  line, after cancelling it if it waits for processes (D21). */
  function trackUpdate(r: UpdateRun): UpdateRun {
    const current = {
      kind: "update" as const,
      cancel: async () => {
        r.cancelWhenWaiting();
        await r.done;
      },
      waiting: r.waiting,
      cancelWhenWaiting: r.cancelWhenWaiting,
      cancelNow: r.cancelNow,
    };
    step = current;
    void r.done.finally(() => {
      if (step === current) step = null;
      updateView = null;
    });
    return r;
  }

  /** The update offer and the separate-install question: the screen's
   *  button resolves; Quit quits the app. */
  function askOnScreen(question: Screen): Promise<void> {
    return new Promise<void>((resolve) => {
      answerUpdate = resolve;
      showScreen(question);
    });
  }

  /** Before a core update (W03c): the busy check with its own wording, then
   *  a stop of the backend the app started, as Restart backend does. A
   *  backend the app reused is left alone; the update then ends with
   *  `server_running`. Callers hold `working`.
   *  Not reached today: `launchLocked` stops `deploy` before every boot, so
   *  the version check never runs with the app's own backend up. It is here
   *  for the issue's order of steps and for a later caller that updates
   *  with the backend running (W04's "Restart to update"). */
  async function stopOwnBackend(): Promise<boolean> {
    if (!ready || !session || !ready.owned) return true;
    if (!(await confirmStop("update"))) return false;
    const current = ready;
    if (!current || !session) return true;
    showScreen(progressScreen("stopping"));
    log.info("waiting for the memory workers before the update");
    log.info(
      `memory workers: ${await deps.waitForMemoryWorkers(
        current.url,
        () => quitState !== "none" || sessionEnd.ending
      )}`
    );
    if (!session) return true;
    const old = session;
    session = null;
    ready = null;
    log.info(`update: stopping deploy (${await stopDeploy(old)})`);
    return true;
  }

  /** Writes a crash report next to the logs and returns its path. */
  function crashReport(code: string, message: string, detail?: unknown) {
    const file = deps.writeCrashReport(log.folder, {
      appVersion: deps.appVersion,
      uiVersion: deps.bundledUiVersion() ?? "unknown",
      coreVersion: core?.version ?? null,
      code,
      message,
      detail,
      logs: [
        log.path,
        uiLog.path,
        ready?.logFile ?? join(deps.runtimeDir, "langgraph_dev.log"),
      ],
    });
    if (file) log.warn(`crash report: ${file}`);
    return file;
  }

  /** Shows the error screen for a code, with a crash report for fatal codes; nothing while quitting. */
  function showError(error: BootError): void {
    // A quit ends the backend and the UI server on purpose; what fails because
    // of that is no crash and has no window to show in.
    if (quitState !== "none") {
      // During the quit question the quit may still be cancelled: keep it.
      if (quitState === "checking" && error.code !== "quitting")
        heldError ??= error;
      log.info(`error during quit, not shown: ${error.code}: ${error.message}`);
      return;
    }
    log.warn(`error screen ${error.code}: ${error.message}`);
    shownError = error.code;
    const report = FATAL_CODES.has(error.code)
      ? crashReport(error.code, error.message, error.detail)
      : null;
    showScreen(
      errorScreen(error, {
        platform: deps.platform,
        port: startConfig?.port ?? DEFAULT_BACKEND_PORT,
        logFolder: log.folder,
        crashReport: report,
        portFromEnv: Boolean(deps.env.EVOSCIENTIST_LANGGRAPH_DEV_PORT?.trim()),
        workspaceFromEnv: Boolean(deps.env.EVOSCIENTIST_WORKSPACE_DIR?.trim()),
      })
    );
  }

  /** The renderer or the preload is broken: the status page may not render
   *  either, so a native dialog shows the error. */
  async function nativeError(code: string, message: string): Promise<void> {
    const report = crashReport(code, message);
    const r = await deps.messageBox({
      type: "error",
      title: "EvoScientist",
      message: "The EvoScientist window stopped working.",
      detail: `${message}${report ? `\n\nCrash report: ${report}` : ""}`,
      buttons: ["Reload", "Quit"],
      defaultId: 0,
      noLink: true,
    });
    if (r.response === 1) return void requestQuit();
    if (showingUi && ui) {
      win?.loadUrl(ui.url).catch((e) => log.warn(`reload: ${e}`));
    } else {
      onStatusPage = false;
      showScreen(screen);
    }
  }

  // --- Launch -------------------------------------------------------------------

  /** Version check and `deploy` (a running `deploy` is stopped first), then
   *  the UI. Callers hold `working`. */
  async function launchLocked(): Promise<void> {
    if (session) {
      const old = session;
      session = null;
      ready = null;
      await stopDeploy(old);
    }
    if (quitState !== "none") return;
    const options: BootOptions = { cn: preferCn, skipSetup };
    try {
      deps.ensureDir(folders.dataDir);
    } catch (e) {
      log.warn(`cannot create ${folders.dataDir}: ${e}`);
    }
    const result = await boot(
      {
        manifest: deps.manifest,
        platform: deps.platform,
        log,
        dataDir: folders.dataDir,
        locate: async () => {
          const found = await deps.locateEvoSci();
          evosci = found?.path ?? null;
          if (found) deps.recordEvoSci(found);
          return evosci;
        },
        runCollect: deps.runCollect,
        startConfig: () => (startConfig = deps.readStartConfig()),
        documentsDir: deps.documentsDir,
        ensureDir: deps.ensureDir,
        startDeploy: (file, workspace) =>
          (session = deps.startDeploy(file, workspace)),
        keptMirror: deps.keptMirror,
        keepMirror: deps.keepMirror,
        askMirror: () =>
          new Promise<boolean>((resolve) => {
            answerMirror = resolve;
            showScreen(mirrorQuestion());
          }),
        windowsArm64: deps.windowsArm64,
        updateLockHeld: deps.updateLockHeld,
        pause,
        // Decided, not only asked: an error during the close question is
        // held and shown if the quit is cancelled.
        stopping: () => quitState === "stopping",
        backupConfig: deps.backupConfig,
        runInstall: (cn, onLine) =>
          track("install", deps.runInstall(cn, onLine)),
        runSetup: (file, cn, stages, onUpdate) =>
          track("setup", deps.runSetup(file, cn, stages, onUpdate)),
        setupRecord: deps.readSetupRecord,
        recordSetup: deps.writeSetupRecord,
        askUpdate: (from) =>
          askOnScreen(updateQuestion(from, deps.manifest.coreRange)),
        askSeparateInstall: (message, from) =>
          askOnScreen(separateInstallQuestion(message, from)),
        stopOwnBackend,
        lookupRelease: deps.lookupRelease,
        runUpdate: (file, version, stages, onUpdate) =>
          trackUpdate(deps.runUpdate(file, version, stages, onUpdate)),
        backendAnswers: deps.backendAnswers,
        uvToolEnvExists: deps.uvToolEnvExists,
      },
      onBootState,
      options
    );
    if (!result.ok) return showError(result.error);

    core = result.core;
    const filled = withReadyFolders(result.ready, folders);
    if (filled.missing.length > 0)
      log.warn(
        `ready without ${filled.missing.join(
          ", "
        )}; using the app's own folders`
      );
    ready = filled.ready;
    const logDir = dirname(ready.logFile);
    log.moveTo(logDir);
    uiLog.moveTo(logDir);
    log.info(
      `backend ready at ${ready.url} (owned ${ready.owned}) for ${ready.workspace}`
    );
    // Registered last: a loss that came before registration is delivered at
    // once and clears `ready`.
    const current = result.session;
    current.onLost((e) => {
      if (session !== current) return;
      ready = null;
      const error = {
        code: e.code,
        message: e.message,
        detail: e.detail as Record<string, unknown>,
      };
      if (quitState !== "none") {
        heldError = error;
        return;
      }
      const shown = sessionEnd.report(() => {
        if (session === current && quitState === "none") showError(error);
      });
      if (shown !== "now")
        log.info(`backend lost during the end of the session: ${shown}`);
    });
    await showUiLocked();
    if (result.notice && showingUi) {
      log.info(`notice: ${result.notice}`);
      void deps.messageBox({
        type: "info",
        title: "EvoScientist",
        message: "EvoScientist was installed for the app.",
        detail: result.notice,
        buttons: ["OK"],
        noLink: true,
      });
    }
  }

  /** Starts the UI server for a backend and waits until it answers. Callers hold `working`. */
  async function startUiLocked(r: DeployReady): Promise<void> {
    await stopUi();
    if (quitState !== "none") throw new Error("the app is quitting");
    await deps.stopLeftoverUi(deps.readUiRecord());
    const { port, fallback } = await deps.pickUiPort(deps.uiPort);
    if (fallback)
      log.warn(
        `UI port ${deps.uiPort} is taken; using ${port}. The WebUI's saved settings belong to the port, so they start empty.`
      );
    if (!deps.fileExists(deps.uiServerJs))
      throw new Error(`the bundled WebUI is missing: ${deps.uiServerJs}`);
    const started = deps.startUiServer({
      execPath: deps.execPath,
      entryScript: deps.uiEntry,
      cwd: folders.dataDir,
      env: deps.uiServerEnv({
        uiPort: port,
        backendUrl: r.url,
        dataDir: r.dataDir,
        configDir: r.configDir,
        serverJs: deps.uiServerJs,
      }),
      port,
      log: uiLog,
    });
    ui = started;
    uiBackendUrl = r.url;
    log.info(`UI server pid ${started.pid} on ${started.url}`);
    if (started.pid) {
      const pid = started.pid;
      void deps.processStartTime(pid).then((startTime) => {
        if (startTime && ui === started)
          deps.writeUiRecord({ pid, port, startTime });
      });
    }
    started.exited.then((exit) => {
      if (ui !== started) return;
      deps.writeUiRecord(null);
      ui = null;
      uiBackendUrl = null;
      if (!showingUi) return;
      const error = {
        code: "ui_server_exited",
        message: `The WebUI server exited (code ${exit.code}${
          exit.signal ? `, signal ${exit.signal}` : ""
        }).`,
        detail: { exit_code: exit.code },
      };
      // A backend loss held first is the error the user has to act on.
      if (quitState !== "none") {
        heldError ??= error;
        return;
      }
      const shown = sessionEnd.report(() => {
        if (ui === null && quitState === "none") showError(error);
      });
      if (shown !== "now")
        log.info(`UI server exited during the end of the session: ${shown}`);
    });
    await started.whenAnswering(UI_START_MS);
  }

  /** Starts the UI server when none runs for this backend URL (a new port
   *  restarts it), then loads it. */
  async function showUiLocked(): Promise<void> {
    const r = ready;
    if (!r) return;
    try {
      if (!ui || uiBackendUrl !== r.url) {
        showScreen(progressScreen("starting_ui"));
        await startUiLocked(r);
      }
    } catch (e) {
      await stopUi();
      // A backend lost meanwhile has shown its own error.
      if (ready !== r) return;
      // Refused because a quit is being decided (a step ended during the
      // close question): Cancel starts the UI again, Quit stops everything.
      if (quitState !== "none")
        return log.info(`UI start during the quit question, not shown: ${e}`);
      return showError({
        code: "ui_server_exited",
        message: `The WebUI server did not start: ${
          e instanceof Error ? e.message : String(e)
        }`,
        detail: { server_js: deps.uiServerJs },
      });
    }
    if (ready !== r || !win || !ui) return;
    // A restart from the page keeps the page when it still fits: the same UI
    // server (so the same backend URL) and the same folder. Otherwise a status
    // screen has replaced it already, or its saved URL or threads are stale.
    if (pageRestart && showingUi && lastUiWorkspace === r.workspace) {
      log.info("restart from the page: the page stays");
    } else {
      // The same folder gets back the page the user was on, on the current UI
      // server (its port can change); a new folder starts at `/`, since the
      // WebUI would show the old folder's thread read-only.
      const page = new URL(ui.url);
      if (lastUiUrl && lastUiWorkspace === r.workspace) {
        const saved = new URL(lastUiUrl);
        page.pathname = saved.pathname;
        page.search = saved.search;
        page.hash = saved.hash;
      }
      onStatusPage = false;
      showingUi = true;
      lastUiUrl = page.href;
      lastUiWorkspace = r.workspace;
      try {
        await win.loadUrl(page.href);
      } catch (e) {
        log.warn(`loading the UI: ${e}`);
        return; // did-fail-load shows the native dialog
      }
    }
    if (r.warnings.length > 0) {
      void deps.messageBox({
        type: "warning",
        title: "EvoScientist",
        message: "EvoScientist started with warnings.",
        detail: r.warnings.join("\n\n"),
        buttons: ["OK"],
        noLink: true,
      });
    }
  }

  /** Stops the UI server and removes its record. */
  async function stopUi(): Promise<void> {
    const current = ui;
    if (!current) return;
    ui = null;
    uiBackendUrl = null;
    await current.stop();
    deps.writeUiRecord(null);
  }

  /** Runs one launch, restart or screen action at a time. */
  async function exclusive(task: () => Promise<void>): Promise<void> {
    if (working || quitState !== "none") return;
    working = true;
    try {
      await task();
    } catch (e) {
      log.warn(`unexpected: ${e instanceof Error ? e.stack : e}`);
      showError({
        code: "internal_error",
        message: e instanceof Error ? e.message : String(e),
        detail: {},
      });
    } finally {
      working = false;
    }
  }

  /** Retry: the whole launch sequence again. */
  const launch = () => exclusive(launchLocked);

  // --- Close check, restart, quit ----------------------------------------------

  /** The busy check before stopping an owned backend; true to go on. */
  async function confirmStop(purpose: StopPurpose): Promise<boolean> {
    if (!ready) return true;
    return askStop(purpose, await checkWorkLogged(ready.url, purpose));
  }

  /** The work check, logged with what it is for. */
  async function checkWorkLogged(
    url: string,
    purpose: string
  ): Promise<WorkCheck> {
    const check = await deps.checkWork(url);
    log.info(`work check before ${purpose}: ${JSON.stringify(check)}`);
    return check;
  }

  /** The question for a work check, when it needs one; true to go on. */
  async function askStop(
    purpose: StopPurpose,
    check: WorkCheck
  ): Promise<boolean> {
    const c = confirmation(check, purpose);
    if (!c) return true;
    const r = await deps.messageBox({
      type: "warning",
      title: "EvoScientist",
      message: c.message,
      detail: c.detail,
      buttons: c.buttons,
      defaultId: c.defaultId,
      cancelId: 1,
      noLink: true,
    });
    log.info(`confirmation: ${r.response === 0 ? c.buttons[0] : "Cancel"}`);
    return r.response === 0;
  }

  /** The question before closing while `EvoSci update` runs (D21): it is
   *  never killed, so the app quits after its terminal line; while it waits
   *  for processes, closing cancels it. True to quit. */
  async function confirmStopUpdate(
    waiting: boolean,
    afterFailedRun: boolean
  ): Promise<boolean> {
    const r = await deps.messageBox({
      type: "warning",
      title: "EvoScientist",
      message: "EvoScientist is being updated.",
      detail: waiting
        ? afterFailedRun
          ? "Closing cancels the update. Its first install attempt failed, so EvoScientist may need a repair at the next launch. The app quits once it has stopped."
          : "Closing cancels the update; nothing is changed. The app quits once it has stopped."
        : `The update finishes first${
            deps.platform === "win32"
              ? " (on Windows it would go on without the app)"
              : ""
          }, unless it still has to wait for programs that run EvoScientist: closing then cancels it. The app quits when it is done.`,
      buttons: ["Quit after the update", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    log.info(
      `confirmation (update): ${
        r.response === 0 ? "Quit after the update" : "Cancel"
      }`
    );
    return r.response === 0;
  }

  /** The question before closing while the install script or setup runs;
   *  true to quit. */
  async function confirmStopStep(kind: "install" | "setup"): Promise<boolean> {
    const what =
      kind === "install"
        ? "EvoScientist is being installed."
        : "EvoScientist is being set up.";
    const r = await deps.messageBox({
      type: "warning",
      title: "EvoScientist",
      message: what,
      detail:
        "Quitting stops it now. The app runs it again at the next launch.",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    log.info(`confirmation (${kind}): ${r.response === 0 ? "Quit" : "Cancel"}`);
    return r.response === 0;
  }

  /** File > Restart backend: asks, waits for the memory workers, stops the owned backend and launches again. A reused backend is left alone. */
  function restartBackend(): Promise<void> {
    return exclusive(async () => void (await restartLocked(false)));
  }

  let pageRun: Promise<RestartResult> | null = null;

  /** The bridge's restart (W03d): the menu's steps, while the page stays
   *  shown when it still fits (`showUiLocked`); resolves once the new backend
   *  is ready, or with the reason it did not restart. A call while one runs
   *  waits for that one. */
  function restartFromPage(): Promise<RestartResult> {
    pageRun ??= runPageRestart().finally(() => (pageRun = null));
    return pageRun;
  }

  async function runPageRestart(): Promise<RestartResult> {
    if (working || quitState !== "none") {
      log.info("restart from the page: busy");
      return { ok: false, code: "busy" };
    }
    let result: RestartResult | null = null;
    pageRestart = true;
    shownError = null;
    try {
      await exclusive(async () => {
        result = await restartLocked(true);
      });
    } finally {
      pageRestart = false;
    }
    // An exception ended it: `exclusive` showed `internal_error`.
    result ??= { ok: false, code: shownError ?? "failed" };
    log.info(`restart from the page: ${JSON.stringify(result)}`);
    return result;
  }

  /** The restart itself. From the page, a reused backend and a Cancel are
   *  answered to the page instead of a dialog or silence, and the window keeps
   *  the page while the backend stops. Callers hold `working`. */
  async function restartLocked(fromPage: boolean): Promise<RestartResult> {
    if (!ready || !session) return relaunched();
    if (!ready.owned) {
      log.info("restart backend: reused backend, nothing changed");
      if (fromPage) return { ok: false, code: "not_owned" };
      await deps.messageBox({
        type: "info",
        title: "EvoScientist",
        message: "This backend was started outside the app.",
        detail:
          "To restart it, run EvoSci server stop in a terminal, then press Retry in the app, which starts its own. Stopping it ends running work in every project that uses this backend. The app changed nothing.",
        buttons: ["OK"],
        noLink: true,
      });
      return { ok: false, code: "not_owned" };
    }
    const before = await checkWorkLogged(ready.url, "restart");
    if (!(await askStop("restart", before)))
      return { ok: false, code: "cancelled" };
    // The backend may have gone while the question was open: start a new one.
    const current = ready;
    if (!current || !session) return relaunched();
    if (!fromPage || !showingUi) showScreen(progressScreen("stopping"));
    // The same wait as at quit, so the last turn's observation linker runs.
    log.info("waiting for the memory workers before restarting the backend");
    const memory = await deps.waitForMemoryWorkers(
      current.url,
      () => quitState !== "none" || sessionEnd.ending
    );
    log.info(`memory workers: ${memory}`);
    if (quitState !== "none" || sessionEnd.ending || !session)
      return { ok: false, code: "busy" };
    // The page stayed usable through the wait: work started meanwhile gets
    // its own question (the user answered only for what ran before).
    if (fromPage) {
      const started = workStartedSince(
        before,
        await checkWorkLogged(current.url, "restart, after the wait")
      );
      if (
        started &&
        ready === current &&
        !(await askStop("restart", started))
      ) {
        if (!showingUi) await showUiLocked();
        return { ok: false, code: "cancelled" };
      }
      if (quitState !== "none" || sessionEnd.ending || !session)
        return { ok: false, code: "busy" };
    }
    const old = session;
    session = null;
    ready = null;
    log.info(`restart backend: stopping deploy (${await stopDeploy(old)})`);
    return relaunched();
  }

  /** Launches again; the result is the error the launch showed (also after
   *  `ready`, when the UI server did not start), else the new backend. */
  async function relaunched(): Promise<RestartResult> {
    shownError = null;
    await launchLocked();
    if (shownError) return { ok: false, code: shownError };
    if (ready) return { ok: true };
    return {
      ok: false,
      code: screen.kind === "error" ? screen.code : "failed",
    };
  }

  /** Stops a `deploy` the app has let go of, recorded so a quit waits for it. */
  async function stopDeploy(old: DeploySession): Promise<"stopped" | "killed"> {
    const stop = old.stop();
    stoppingDeploy = stop;
    try {
      return await stop;
    } finally {
      if (stoppingDeploy === stop) stoppingDeploy = null;
    }
  }

  /** "Restart to update" (D5): the quit's busy check, then the status page's
   *  "Getting ready to update..." during the memory wait, a second check for
   *  work that started meanwhile (a scheduled task; Cancel brings the app
   *  back with its backend), the stops, and only then the installer, which
   *  first waits for the app to end (installer/check-app-running.nsh). A
   *  backend the app reused keeps running. Never at the end of the session
   *  and never on an ordinary quit: nothing else calls `install()`. An
   *  installer file that cannot be opened stops it before anything stops (the
   *  download is offered again); an error in the steps brings the app back. */
  async function restartToUpdate(): Promise<RestartResult> {
    const update = deps.appUpdate;
    if (!update || update.state.kind !== "ready")
      return { ok: false, code: "not_ready" };
    if (working || step || quitState !== "none" || sessionEnd.ending) {
      log.info("restart to update: busy");
      return { ok: false, code: "busy" };
    }
    if (!update.installable()) return { ok: false, code: "not_ready" };
    quitState = "checking";
    heldError = null;
    let stopping = false;
    const cancel = (): RestartResult => {
      quitState = "none";
      resumeAfterCancelledQuit();
      return { ok: false, code: "cancelled" };
    };
    try {
      const owned = ready?.owned && session ? ready : null;
      const before = owned
        ? await checkWorkLogged(owned.url, "the app update")
        : null;
      if (before && !(await askStop("update", before))) return cancel();
      // The session ends: Windows ends the app right after (endOfSession).
      if (sessionEnd.ending) return { ok: false, code: "busy" };
      showScreen(progressScreen("preparing_update"));
      if (owned && before && ready === owned) {
        quitState = "waiting";
        quitCancelled = false;
        log.info("waiting for the memory workers before the app update");
        const r = await deps.waitForMemoryWorkers(
          owned.url,
          () => quitCancelled || sessionEnd.ending
        );
        log.info(`memory workers: ${r}`);
        if (sessionEnd.ending) return { ok: false, code: "busy" };
        if (quitCancelled) {
          log.info("second launch during the wait: app update cancelled");
          return cancel();
        }
        const started = workStartedSince(
          before,
          await checkWorkLogged(owned.url, "the app update, after the wait")
        );
        if (started && ready === owned && !(await askStop("update", started)))
          return cancel();
        if (sessionEnd.ending) return { ok: false, code: "busy" };
      }
      quitState = "stopping";
      stopping = true;
      await stopUi();
      if (session) {
        const s = session;
        session = null;
        ready = null;
        log.info(
          `stopping deploy (${owned ? "owned" : "reused"}): ${await s.stop()}`
        );
      }
      if (stoppingDeploy)
        log.info(
          `waiting for the deploy being stopped: ${await stoppingDeploy}`
        );
      if (sessionEnd.ending) {
        exitNow();
        return { ok: false, code: "busy" };
      }
      // The installer's `app.quit()` must go through the close handlers.
      exiting = true;
      update.stop();
      if (!update.install()) return updateDidNotStart();
      void (deps.installWait ?? defaultInstallWait)().then(() => {
        if (exiting && quitState === "stopping") void updateDidNotStart();
      });
      return { ok: true };
    } catch (e) {
      log.warn(
        `restart to update failed: ${e instanceof Error ? e.message : e}`
      );
      if (!stopping) return cancel();
      return updateDidNotStart();
    }
  }

  /** The installer file could not be opened, the steps failed after the
   *  stops, or the app was still running 15 s after the installer was asked
   *  for: the app starts again on the current version and says so. (A start
   *  of the installer that fails after electron-updater has quit the app is
   *  not seen: the next launch offers the update again.) */
  async function updateDidNotStart(): Promise<RestartResult> {
    log.warn("restart to update: the installer did not start; launching again");
    exiting = false;
    quitState = "none";
    await launch();
    void deps.messageBox({
      type: "warning",
      title: "EvoScientist",
      message: "The update could not be installed.",
      detail:
        "EvoScientist runs the current version. The desktop log has the details; the app offers the update again.",
      buttons: ["OK"],
      noLink: true,
    });
    return { ok: false, code: "update_failed" };
  }

  /** After a cancelled quit: shows an error held during the quit question, or
   *  brings back the UI that a restart or launch left for the quit. */
  function resumeAfterCancelledQuit(): void {
    if (quitForInstall) {
      quitForInstall = false;
      log.info("quit for the installer cancelled: the installer stops");
      deps.installQuitCancelled?.();
    }
    const error = heldError;
    heldError = null;
    if (error) return showError(error);
    if (working || showingUi || screen.kind !== "progress") return;
    void exclusive(async () =>
      ready && session ? showUiLocked() : launchLocked()
    );
  }

  /** The end of the system session (D5): no confirmation, no memory wait. On
   *  Windows the process ends right after `session-end` returns, so this only
   *  writes one log line (synchronously) and closes both stdin pipes; the
   *  backend's job object does the rest if `deploy` dies first. At a real
   *  sign-out Windows has usually ended `deploy` already, right after
   *  `query-session-end` (see sessionEnd.ts). */
  function endOfSession(why: string): void {
    if (sessionEnd.ending) return;
    sessionEnd.end();
    log.info(
      `${why}: stopping without confirmation; closing the stdin of deploy and the UI server`
    );
    session?.closeStdinNow();
    ui?.closeStdinNow();
  }

  /** Closing the window or Quit: asks when work runs on an owned backend, hides the windows, waits for the memory workers, stops what the app started, then exits. */
  async function requestQuit(): Promise<void> {
    if (quitState !== "none") return;
    quitState = "checking";
    heldError = null;
    try {
      // The install script or setup runs (D14): ask, then stop its tree. The
      // next launch runs that step again. An update is asked about on its
      // own and waited for (D21).
      if (
        step &&
        !sessionEnd.ending &&
        !(await (step.kind === "update"
          ? confirmStopUpdate(
              step.waiting?.() ?? false,
              updateView?.afterFailedRun === true
            )
          : confirmStopStep(step.kind)))
      ) {
        quitState = "none";
        resumeAfterCancelledQuit();
        return;
      }
      // The window stays on the update's rows until it ends (D21).
      const waitForUpdate = step?.kind === "update" && !sessionEnd.ending;
      if (waitForUpdate) {
        quitAfterUpdate = true;
        step?.cancelWhenWaiting?.();
        if (updateView) showScreen(updateScreen(updateView, true));
      }
      const owned = Boolean(ready?.owned && session);
      if (owned && !sessionEnd.ending && !(await confirmStop("quit"))) {
        quitState = "none";
        resumeAfterCancelledQuit();
        return;
      }
      // Hidden, never destroyed: a destroyed window gets no `session-end` (D5).
      // Windows opened from the UI hide too.
      const showAgain = win && !waitForUpdate ? win.hideAll() : () => {};
      if (owned && ready && !sessionEnd.ending) {
        quitState = "waiting";
        quitCancelled = false;
        log.info("waiting for the memory workers before stopping the backend");
        const r = await deps.waitForMemoryWorkers(
          ready.url,
          () => quitCancelled || sessionEnd.ending
        );
        log.info(`memory workers: ${r}`);
        // A second launch during the last probe cancels too, whatever the
        // wait returned.
        if (quitCancelled && !sessionEnd.ending) {
          quitState = "none";
          log.info("second launch during the wait: quit cancelled");
          showAgain();
          win?.focus();
          resumeAfterCancelledQuit();
          return;
        }
      }
      quitState = "stopping";
      if (step) {
        const running = step;
        log.info(
          running.kind === "update"
            ? "waiting for the update to end"
            : `stopping the ${running.kind} step`
        );
        await running.cancel();
      }
      await stopUi();
      if (session) {
        const s = session;
        session = null;
        // A reused backend keeps running: its `deploy` only detaches.
        log.info(
          `stopping deploy (${owned ? "owned" : "reused"}): ${await s.stop()}`
        );
      }
      // A restart's stop still under way finishes, so the job object does not
      // end `deploy` in the middle of it.
      if (stoppingDeploy)
        log.info(
          `waiting for the deploy being stopped: ${await stoppingDeploy}`
        );
    } catch (e) {
      log.warn(`while quitting: ${e instanceof Error ? e.stack : e}`);
    }
    exitNow();
  }

  /** Ends the app (and relaunches it when a second launch came during the stop). */
  function exitNow(): void {
    exiting = true;
    log.info(relaunchAfterExit ? "exit, then relaunch" : "exit");
    log.close();
    uiLog.close();
    deps.exit(relaunchAfterExit);
  }

  /** A second launch: cancels a quit that waits for the memory workers,
   *  relaunches after one that is stopping, else brings the window back. */
  function secondInstance(forInstall = false): void {
    if (forInstall) {
      // A quit that runs goes on (no cancel, no relaunch) and the installer
      // waits for it; else the normal quit starts, with its busy question.
      // Either way a Cancel tells the installer. Ignored once the app exits
      // (its own "Restart to update" started that installer).
      log.info(`the installer asks the app to quit (quit state ${quitState})`);
      if (exiting) return;
      quitForInstall = true;
      if (quitState === "none") void requestQuit();
      return;
    }
    log.info(`second launch (quit state ${quitState})`);
    if (quitState === "waiting") {
      quitCancelled = true;
      return;
    }
    if (quitState === "stopping") {
      relaunchAfterExit = true;
      return;
    }
    win?.bringToFront();
  }

  // --- Status page actions ---------------------------------------------------

  /** Saves one config key with `EvoSci config set`; true when it worked. */
  async function setConfig(key: string, value: string): Promise<boolean> {
    if (!evosci) return false;
    const r = await deps.runCollect(
      evosci,
      ["config", "set", key, value],
      folders.dataDir,
      60_000
    );
    log.info(`EvoSci config set ${key}: exit ${r.code} ${r.stdout.join(" ")}`);
    if (r.code === 0) return true;
    const s = screen;
    if (s.kind === "error")
      showScreen({
        ...s,
        lines: [
          ...s.lines,
          `Could not save ${key}: ${
            r.stdout.join(" ") || "EvoSci config set failed"
          }`,
        ],
      });
    return false;
  }

  /** Runs an action from the error screen's buttons. */
  async function act(id: ActionId, arg: unknown): Promise<void> {
    const s = screen as ErrorScreen;
    switch (id) {
      case "retry":
        return launch();
      case "restart_ui":
        return exclusive(async () => (ready ? showUiLocked() : launchLocked()));
      case "set_port": {
        const port = Number(arg);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;
        return exclusive(async () => {
          if (await setConfig("langgraph_dev_port", String(port)))
            await launchLocked();
        });
      }
      case "choose_folder": {
        const folder = await deps.chooseFolder("Choose a folder for your work");
        if (!folder) return;
        return exclusive(async () => {
          if (await setConfig("default_workdir", folder)) await launchLocked();
        });
      }
      case "copy_command":
        if (s.command) deps.copyText(s.command);
        return;
      case "open_logs":
        deps.openPath(log.folder);
        return;
      case "open_config":
        deps.openPath(folders.configDir);
        return;
      case "open_crash":
        if (s.crashReport) deps.showItemInFolder(s.crashReport);
        return;
      case "quit":
        return requestQuit();
      case "mirror_cn":
      case "mirror_default": {
        const answer = answerMirror;
        answerMirror = null;
        answer?.(id === "mirror_cn");
        return;
      }
      case "retry_cn":
        // Remembered: kept as the mirror answer, and setup saves `mirror: cn`.
        deps.keepMirror(true);
        preferCn = true;
        return launch();
      case "continue":
        skipSetup = true;
        return launch();
      case "update":
      case "install_copy": {
        const answer = answerUpdate;
        answerUpdate = null;
        answer?.();
        return;
      }
      case "cancel_update":
        if (step?.kind === "update" && step.cancelNow?.())
          log.info("update cancelled from the waiting screen");
        return;
    }
  }

  return {
    attachWindow: (w) => void (win = w),
    start: () => {
      showScreen(screen);
      // Also when the launch stops on the status page: `core_too_new` tells
      // the user to update the app.
      deps.appUpdate?.start();
      void launch();
    },
    launch,
    restartBackend,
    restartFromPage,
    restartToUpdate,
    requestQuit,
    act,
    nativeError,
    crashReport,
    secondInstance,
    querySessionEnd: (reasons) => {
      sessionEnd.queried();
      log.info(`query-session-end (${reasons.join(",")})`);
    },
    endOfSession,
    get screen() {
      return screen;
    },
    uiOrigin,
    backendUrlFor: (senderOrigin) =>
      fromUi(senderOrigin) && ready ? ready.url : null,
    defaultFolderFor: (senderOrigin) => {
      if (!fromUi(senderOrigin)) return null;
      try {
        return defaultFolder(deps);
      } catch (e) {
        log.warn(`no default folder for the page: ${e}`);
        return null;
      }
    },
    updateChanged: (state) => {
      log.info(`app update: ${JSON.stringify(state)}`);
      win?.sendUpdate(state, updateOffer(state));
    },
    updateFor: (senderOrigin, statusPage) =>
      (statusPage || fromUi(senderOrigin)) && deps.appUpdate
        ? deps.appUpdate.state
        : { kind: "none" },
    updateOfferFor: (statusPage) =>
      statusPage && deps.appUpdate ? updateOffer(deps.appUpdate.state) : null,
    downloadUpdateFor: (senderOrigin, statusPage) => {
      if (statusPage || fromUi(senderOrigin)) deps.appUpdate?.download();
      else log.warn(`update download refused for the origin ${senderOrigin}`);
    },
    restartToUpdateFor: async (senderOrigin, statusPage) => {
      if (statusPage || fromUi(senderOrigin)) return restartToUpdate();
      log.warn(`restart to update refused for the origin ${senderOrigin}`);
      return { ok: false, code: "not_allowed" };
    },
    restartFor: async (senderOrigin) => {
      if (fromUi(senderOrigin)) return restartFromPage();
      log.warn(`restart refused for the origin ${senderOrigin}`);
      return { ok: false, code: "not_allowed" };
    },
    get exiting() {
      return exiting;
    },
    get quitState() {
      return quitState;
    },
  };
}
