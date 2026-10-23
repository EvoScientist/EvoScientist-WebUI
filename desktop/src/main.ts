// The desktop app's main process: one instance, one window, one backend.
// It runs the launch sequence (boot.ts) on the installed core, serves the
// bundled WebUI with Electron's own Node (uiServer.ts) and shows it in a
// sandboxed window. While the UI is not up, the window shows a static status
// page (resources/status.html) that never calls the backend. Closing checks
// for work on a backend the app started, hides the window, waits for the
// memory workers, then stops the UI server and that backend.
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  session as electronSession,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type WebContents,
} from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boot, type BootError, type Manifest } from "./boot";
import {
  backendRequest,
  checkWork,
  confirmation,
  waitForMemoryWorkers,
  type StopPurpose,
} from "./closeCheck";
import { FATAL_CODES, writeCrashReport } from "./crash";
import { startDeploy, type DeploySession } from "./deploy";
import {
  processStartTime,
  readUiRecord,
  stopLeftoverUi,
  uiRecordPath,
  writeUiRecord,
} from "./leftover";
import type { DeployReady, VersionInfo } from "./lines";
import { classifyLink } from "./links";
import { locateEvoSci, uvToolBinDir, type Located } from "./locate";
import { DESKTOP_LOG, DESKTOP_UI_LOG, FileLog } from "./logs";
import {
  DEFAULT_BACKEND_PORT,
  folderEnv,
  readStartConfig,
  resolveFolders,
  runtimeDir,
  type StartConfig,
} from "./paths";
import { killTree, runCollect } from "./proc";
import { SessionEnd } from "./sessionEnd";
import {
  errorScreen,
  progressScreen,
  type ActionId,
  type ErrorScreen,
  type Screen,
} from "./screens";
import {
  pickUiPort,
  startUiServer,
  uiServerEnv,
  type UiServer,
} from "./uiServer";

/** How long the UI server gets to answer `/` after it starts. */
const UI_START_MS = 60_000;

const STATUS_HTML = join(__dirname, "..", "resources", "status.html");
const PRELOAD = join(__dirname, "preload.js");
/** Outside asar: the UI server reads real files and runs as plain Node. */
const UI_ENTRY = app.isPackaged
  ? join(process.resourcesPath, "ui-entry.mjs")
  : join(__dirname, "..", "resources", "ui-entry.mjs");
/** The root `npm run build` output, copied by electron-builder's
 *  extraResources; in development the repository's own `dist/`. */
const UI_SERVER_JS = app.isPackaged
  ? join(process.resourcesPath, "ui", "server.js")
  : join(__dirname, "..", "..", "dist", "server.js");

const pkg = JSON.parse(
  readFileSync(join(app.getAppPath(), "package.json"), "utf8")
) as {
  evoscientist: { coreRange: string; protocols: number[]; uiPort: number };
};
const manifest: Manifest = {
  coreRange: pkg.evoscientist.coreRange,
  protocols: pkg.evoscientist.protocols,
  uiVersion: app.getVersion(),
};

const folders = resolveFolders(process.env);
const childEnv = folderEnv(process.env, folders) as NodeJS.ProcessEnv;
const echo = app.isPackaged ? undefined : (l: string) => console.log(l);
const log = new FileLog(runtimeDir(), DESKTOP_LOG, echo);
const uiLog = new FileLog(runtimeDir(), DESKTOP_UI_LOG);

const WEB_PREFERENCES = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
} as const;

// --- State --------------------------------------------------------------------

let win: BrowserWindow | null = null;
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
/** A launch, restart or action on the error screen is running. */
let working = false;
let quitState: "none" | "checking" | "waiting" | "stopping" = "none";
let quitCancelled = false;
let relaunchAfterExit = false;
const sessionEnd = new SessionEnd();
let exiting = false;

const uiOrigin = (): string | null => (ui ? new URL(ui.url).origin : null);

// --- Screens --------------------------------------------------------------------

function showScreen(s: Screen): void {
  screen = s;
  showingUi = false;
  if (!win) return;
  if (onStatusPage) {
    win.webContents.send("status:screen", s);
    return;
  }
  onStatusPage = true;
  win.loadFile(STATUS_HTML).catch((e) => log.warn(`status page: ${e}`));
}

function crashReport(code: string, message: string, detail?: unknown) {
  const file = writeCrashReport(log.folder, {
    appVersion: app.getVersion(),
    coreVersion: core?.version ?? null,
    code,
    message,
    detail,
    logs: [
      log.path,
      uiLog.path,
      ready?.logFile ?? join(runtimeDir(), "langgraph_dev.log"),
    ],
  });
  if (file) log.warn(`crash report: ${file}`);
  return file;
}

function showError(error: BootError): void {
  log.warn(`error screen ${error.code}: ${error.message}`);
  const report = FATAL_CODES.has(error.code)
    ? crashReport(error.code, error.message, error.detail)
    : null;
  showScreen(
    errorScreen(error, {
      platform: process.platform,
      port: startConfig?.port ?? DEFAULT_BACKEND_PORT,
      logFolder: log.folder,
      crashReport: report,
    })
  );
}

/** The renderer or the preload is broken: the status page may not render
 *  either, so a native dialog shows the error. */
async function nativeError(code: string, message: string): Promise<void> {
  const report = crashReport(code, message);
  const r = await dialog.showMessageBox({
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
    win?.loadURL(ui.url).catch((e) => log.warn(`reload: ${e}`));
  } else {
    onStatusPage = false;
    showScreen(screen);
  }
}

// --- Launch -------------------------------------------------------------------

function recordEvoSci(found: Located): void {
  try {
    writeFileSync(
      join(app.getPath("userData"), "evosci.json"),
      JSON.stringify({ ...found, recorded: new Date().toISOString() })
    );
  } catch (e) {
    log.warn(`cannot record the EvoSci path: ${e}`);
  }
}

/** Version check and `deploy` (a running `deploy` is stopped first), then
 *  the UI. Callers hold `working`. */
async function launchLocked(): Promise<void> {
  if (session) {
    const old = session;
    session = null;
    ready = null;
    await old.stop();
  }
  try {
    mkdirSync(folders.dataDir, { recursive: true });
  } catch (e) {
    log.warn(`cannot create ${folders.dataDir}: ${e}`);
  }
  const result = await boot(
    {
      manifest,
      platform: process.platform,
      log,
      dataDir: folders.dataDir,
      locate: async () => {
        const found = await locateEvoSci({
          dataDir: folders.dataDir,
          env: childEnv,
          toolBinDir: uvToolBinDir(childEnv, folders.dataDir),
        });
        evosci = found?.path ?? null;
        if (found) recordEvoSci(found);
        return evosci;
      },
      runCollect: (file, args, cwd, timeoutMs) =>
        runCollect(file, args, { cwd, env: childEnv, timeoutMs, log }),
      startConfig: () =>
        (startConfig = readStartConfig(folders.configDir, process.env)),
      documentsDir: () => app.getPath("documents"),
      ensureDir: (p) => void mkdirSync(p, { recursive: true }),
      startDeploy: (file, workspace) =>
        (session = startDeploy(file, workspace, childEnv, { log })),
    },
    (state) => {
      if (state.phase !== "ready" && state.phase !== "error")
        showScreen(progressScreen(state));
    }
  );
  if (!result.ok) return showError(result.error);

  core = result.core;
  ready = result.ready;
  const current = result.session;
  current.onLost((e) => {
    if (session !== current || quitState !== "none") return;
    ready = null;
    const shown = sessionEnd.report(() => {
      if (session === current && quitState === "none")
        showError({
          code: e.code,
          message: e.message,
          detail: e.detail as Record<string, unknown>,
        });
    });
    if (shown !== "now")
      log.info(`backend lost during the end of the session: ${shown}`);
  });
  const logDir = dirname(ready.logFile);
  log.moveTo(logDir);
  uiLog.moveTo(logDir);
  log.info(
    `backend ready at ${ready.url} (owned ${ready.owned}) for ${ready.workspace}`
  );
  await showUiLocked();
}

async function startUiLocked(r: DeployReady): Promise<void> {
  await stopUi();
  if (quitState !== "none") throw new Error("the app is quitting");
  await stopLeftoverUi(readUiRecord(uiRecordPath(app.getPath("userData"))), {
    startTime: (pid) => processStartTime(pid),
    kill: (pid) => killTree(pid, log),
    log,
  });
  const { port, fallback } = await pickUiPort(pkg.evoscientist.uiPort);
  if (fallback)
    log.warn(
      `UI port ${pkg.evoscientist.uiPort} is taken; using ${port}. The WebUI's saved settings belong to the port, so they start empty.`
    );
  if (!existsSync(UI_SERVER_JS))
    throw new Error(`the bundled WebUI is missing: ${UI_SERVER_JS}`);
  const started = startUiServer({
    execPath: process.execPath,
    entryScript: UI_ENTRY,
    cwd: folders.dataDir,
    env: uiServerEnv(process.env, {
      uiPort: port,
      backendUrl: r.url,
      dataDir: r.dataDir,
      configDir: r.configDir,
      serverJs: UI_SERVER_JS,
    }),
    port,
    log: uiLog,
  });
  ui = started;
  uiBackendUrl = r.url;
  log.info(`UI server pid ${started.pid} on ${started.url}`);
  const record = uiRecordPath(app.getPath("userData"));
  if (started.pid) {
    const pid = started.pid;
    void processStartTime(pid).then((startTime) => {
      if (startTime && ui === started)
        writeUiRecord(record, { pid, port, startTime });
    });
  }
  started.exited.then((exit) => {
    if (ui !== started) return;
    writeUiRecord(record, null);
    ui = null;
    uiBackendUrl = null;
    if (!showingUi || quitState !== "none") return;
    const shown = sessionEnd.report(() => {
      if (ui === null && quitState === "none")
        showError({
          code: "ui_server_exited",
          message: `The WebUI server exited (code ${exit.code}${
            exit.signal ? `, signal ${exit.signal}` : ""
          }).`,
          detail: { exit_code: exit.code },
        });
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
    return showError({
      code: "ui_server_exited",
      message: `The WebUI server did not start: ${
        e instanceof Error ? e.message : String(e)
      }`,
      detail: { server_js: UI_SERVER_JS },
    });
  }
  if (!win || !ui) return;
  onStatusPage = false;
  showingUi = true;
  try {
    await win.loadURL(ui.url);
  } catch (e) {
    log.warn(`loading the UI: ${e}`);
    return; // did-fail-load shows the native dialog
  }
  if (r.warnings.length > 0) {
    void dialog.showMessageBox(win, {
      type: "warning",
      title: "EvoScientist",
      message: "EvoScientist started with warnings.",
      detail: r.warnings.join("\n\n"),
      buttons: ["OK"],
      noLink: true,
    });
  }
}

async function stopUi(): Promise<void> {
  const current = ui;
  if (!current) return;
  ui = null;
  uiBackendUrl = null;
  await current.stop();
  writeUiRecord(uiRecordPath(app.getPath("userData")), null);
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

const launch = () => exclusive(launchLocked);

// --- Close check, restart, quit ----------------------------------------------

const messageBox = (opts: MessageBoxOptions) =>
  win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);

/** The busy check before stopping an owned backend; true to go on. */
async function confirmStop(purpose: StopPurpose): Promise<boolean> {
  if (!ready) return true;
  const check = await checkWork(backendRequest(ready.url));
  log.info(`work check before ${purpose}: ${JSON.stringify(check)}`);
  const c = confirmation(check, purpose);
  if (!c) return true;
  const opts = {
    type: "warning" as const,
    title: "EvoScientist",
    message: c.message,
    detail: c.detail,
    buttons: c.buttons,
    defaultId: c.defaultId,
    cancelId: 1,
    noLink: true,
  };
  const r = await messageBox(opts);
  log.info(`confirmation: ${r.response === 0 ? c.buttons[0] : "Cancel"}`);
  return r.response === 0;
}

function restartBackend(): void {
  void exclusive(async () => {
    if (!ready || !session) return launchLocked();
    if (!ready.owned) {
      log.info("restart backend: reused backend, nothing changed");
      await messageBox({
        type: "info",
        title: "EvoScientist",
        message: "This backend was started outside the app.",
        detail:
          "Restart EvoScientist where it was started, for example in its terminal. The app changed nothing.",
        buttons: ["OK"],
        noLink: true,
      });
      return;
    }
    if (!(await confirmStop("restart"))) return;
    showScreen(progressScreen("stopping"));
    const old = session;
    session = null;
    ready = null;
    log.info(`restart backend: stopping deploy (${await old.stop()})`);
    await launchLocked();
  });
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

async function requestQuit(): Promise<void> {
  if (quitState !== "none") return;
  quitState = "checking";
  try {
    const owned = Boolean(ready?.owned && session);
    if (owned && !sessionEnd.ending && !(await confirmStop("quit"))) {
      quitState = "none";
      return;
    }
    // Hidden, never destroyed: a destroyed window gets no `session-end` (D5).
    win?.hide();
    if (owned && ready && !sessionEnd.ending) {
      quitState = "waiting";
      quitCancelled = false;
      log.info("waiting for the memory workers before stopping the backend");
      const r = await waitForMemoryWorkers(backendRequest(ready.url), {
        cancelled: () => quitCancelled || sessionEnd.ending,
      });
      log.info(`memory workers: ${r}`);
      if (r === "cancelled" && quitCancelled) {
        quitState = "none";
        log.info("second launch during the wait: quit cancelled");
        win?.show();
        win?.focus();
        return;
      }
    }
    quitState = "stopping";
    await stopUi();
    if (session) {
      const s = session;
      session = null;
      // A reused backend keeps running: its `deploy` only detaches.
      log.info(
        `stopping deploy (${
          ready?.owned ? "owned" : "reused"
        }): ${await s.stop()}`
      );
    }
  } catch (e) {
    log.warn(`while quitting: ${e instanceof Error ? e.stack : e}`);
  }
  exitNow();
}

function exitNow(): void {
  exiting = true;
  log.info(relaunchAfterExit ? "exit, then relaunch" : "exit");
  log.close();
  uiLog.close();
  if (relaunchAfterExit) app.relaunch();
  app.exit(0);
}

// --- Window ---------------------------------------------------------------------

function guard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = classifyLink(url, uiOrigin());
    if (target === "app")
      return {
        action: "allow",
        overrideBrowserWindowOptions: { webPreferences: WEB_PREFERENCES },
      };
    if (target === "browser") void shell.openExternal(url);
    else log.info(`blocked window for ${url}`);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    const target = classifyLink(url, uiOrigin());
    if (target === "app") return;
    e.preventDefault();
    if (target === "browser") void shell.openExternal(url);
    else log.info(`blocked navigation to ${url}`);
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "EvoScientist",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#24221e" : "#faf9f4",
    webPreferences: WEB_PREFERENCES,
  });
  w.once("ready-to-show", () => w.show());
  w.on("close", (e) => {
    if (exiting) return;
    e.preventDefault();
    void requestQuit();
  });
  w.on("query-session-end", (e) => {
    sessionEnd.queried();
    log.info(`query-session-end (${e.reasons.join(",")})`);
  });
  w.on("session-end", (e) =>
    endOfSession(`session-end (${e.reasons.join(",")})`)
  );
  const contents = w.webContents;
  contents.on("render-process-gone", (_e, d) => {
    log.warn(`renderer gone: ${d.reason} (exit code ${d.exitCode})`);
    if (d.reason === "clean-exit" || exiting) return;
    void nativeError(
      "renderer_gone",
      `The window's renderer process ended: ${d.reason} (exit code ${d.exitCode}).`
    );
  });
  contents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a newer navigation replaced this one.
    if (!isMainFrame || code === -3 || exiting) return;
    log.warn(`did-fail-load ${code} ${description} ${url}`);
    void nativeError(
      "renderer_gone",
      `The window could not load ${url}: ${description} (${code}).`
    );
  });
  contents.on("preload-error", (_e, path, error) => {
    log.warn(`preload error in ${path}: ${error.stack ?? error}`);
    void nativeError("renderer_gone", `The preload script failed: ${error}`);
  });
  return w;
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Restart backend", click: () => restartBackend() },
        {
          label: "Open log folder",
          click: () => void shell.openPath(log.folder),
        },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Status page actions and the URL handover --------------------------------

const fromStatusPage = (e: IpcMainEvent | IpcMainInvokeEvent) =>
  e.senderFrame?.url.startsWith("file:") === true;

async function setConfig(key: string, value: string): Promise<boolean> {
  if (!evosci) return false;
  const r = await runCollect(evosci, ["config", "set", key, value], {
    cwd: folders.dataDir,
    env: childEnv,
    timeoutMs: 60_000,
    log,
  });
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
      if (process.env.EVOSCIENTIST_LANGGRAPH_DEV_PORT)
        log.warn(
          "EVOSCIENTIST_LANGGRAPH_DEV_PORT is set and wins over the saved port"
        );
      return exclusive(async () => {
        if (await setConfig("langgraph_dev_port", String(port)))
          await launchLocked();
      });
    }
    case "choose_folder": {
      const opts = {
        title: "Choose a folder for your work",
        properties: ["openDirectory", "createDirectory"] as (
          | "openDirectory"
          | "createDirectory"
        )[],
      };
      const r = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return;
      const folder = r.filePaths[0];
      return exclusive(async () => {
        if (await setConfig("default_workdir", folder)) await launchLocked();
      });
    }
    case "copy_command":
      if (s.command) clipboard.writeText(s.command);
      return;
    case "open_logs":
      void shell.openPath(log.folder);
      return;
    case "open_config":
      void shell.openPath(folders.configDir);
      return;
    case "open_crash":
      if (s.crashReport) shell.showItemInFolder(s.crashReport);
      return;
    case "quit":
      return requestQuit();
  }
}

function registerIpc(): void {
  ipcMain.handle("status:get", (e) => (fromStatusPage(e) ? screen : null));
  ipcMain.handle("status:act", (e, id: ActionId, arg: unknown) =>
    fromStatusPage(e) ? act(id, arg) : undefined
  );
  // D6: the preload asks synchronously, before any page script runs, and
  // merges the URL into the WebUI's saved config. Only the UI's own origin
  // gets it.
  ipcMain.on("desktop:backend-url", (e) => {
    const origin = uiOrigin();
    let senderOrigin: string | null = null;
    try {
      senderOrigin = e.senderFrame ? new URL(e.senderFrame.url).origin : null;
    } catch {
      senderOrigin = null;
    }
    e.returnValue =
      origin !== null && senderOrigin === origin && ready ? ready.url : null;
  });
}

// --- Start -------------------------------------------------------------------

function start(): void {
  log.info(
    `EvoScientist desktop ${app.getVersion()} (Electron ${
      process.versions.electron
    }, ${process.platform} ${process.arch}), core range ${manifest.coreRange}`
  );
  log.info(`data ${folders.dataDir}, config ${folders.configDir}`);
  process.on("uncaughtException", (e) => {
    log.warn(`uncaught: ${e.stack ?? e}`);
    const report = crashReport("uncaught_exception", String(e));
    dialog.showErrorBox(
      "EvoScientist",
      `${e}${report ? `\n\nCrash report: ${report}` : ""}`
    );
  });
  process.on("unhandledRejection", (e) =>
    log.warn(`unhandled rejection: ${e instanceof Error ? e.stack : e}`)
  );

  app.on("second-instance", () => {
    log.info(`second launch (quit state ${quitState})`);
    if (quitState === "waiting") {
      quitCancelled = true;
      return;
    }
    if (quitState === "stopping") {
      relaunchAfterExit = true;
      return;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.on("before-quit", (e) => {
    if (exiting) return;
    e.preventDefault();
    void requestQuit();
  });
  // The window is hidden, never closed, until the app exits.
  app.on("window-all-closed", () => {});
  app.on("web-contents-created", (_e, contents) => guard(contents));

  void app.whenReady().then(() => {
    if (process.platform !== "win32")
      powerMonitor.on("shutdown", () => endOfSession("shutdown"));
    electronSession.defaultSession.on("will-download", (_e, item) => {
      item.setSaveDialogOptions({
        defaultPath: join(app.getPath("downloads"), item.getFilename()),
      });
      log.info(`download: ${item.getURL()}`);
      item.once("done", (_d, state) =>
        log.info(`download ${state}: ${item.getSavePath()}`)
      );
    });
    registerIpc();
    buildMenu();
    win = createWindow();
    showScreen(screen);
    void launch();
  });
}

if (app.requestSingleInstanceLock()) start();
else app.exit(0);
