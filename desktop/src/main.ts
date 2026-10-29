// The desktop app's main process: one instance, one window, one backend.
// It runs the launch sequence (boot.ts) on the installed core, serves the
// bundled WebUI with Electron's own Node (uiServer.ts) and shows it in a
// sandboxed window. While the UI is not up, the window shows a static status
// page (resources/status.html) that never calls the backend. Closing checks
// for work on a backend the app started, hides the window, waits for the
// memory workers, then stops the UI server and that backend.
//
// The flows and their state live in app.ts; this file builds their
// dependencies from Electron and the process helpers, and wires Electron's
// events to them.
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  powerMonitor,
  session as electronSession,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { autoUpdater, CancellationToken } from "electron-updater";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type AppWindow } from "./app";
import { brief, createAppUpdate } from "./appUpdate";
import type { Manifest } from "./boot";
import { backendRequest, checkWork, waitForMemoryWorkers } from "./closeCheck";
import { writeCrashReport } from "./crash";
import { startDeploy } from "./deploy";
import {
  processStartTime,
  readUiRecord,
  stopLeftoverUi,
  uiRecordPath,
  writeUiRecord,
} from "./leftover";
import { classifyLink } from "./links";
import {
  locateEvoSci,
  uvToolBinDir,
  uvToolDir,
  uvToolEnvExists,
} from "./locate";
import {
  backupConfig,
  installCommand,
  isWindowsArm64,
  runInstallScript,
  updateLockHeld,
} from "./install";
import { DESKTOP_LOG, DESKTOP_UI_LOG, FileLog } from "./logs";
import { answers } from "./loopback";
import {
  folderEnv,
  readStartConfig,
  resolveFolders,
  runtimeDir,
} from "./paths";
import { killTree, runCollect } from "./proc";
import type { ActionId } from "./screens";
import { readSetupRecord, runSetup, writeSetupRecord } from "./setup";
import { lookupNewest } from "./release";
import { pickUiPort, startUiServer, uiServerEnv } from "./uiServer";
import { runUpdate } from "./update";
import { bundledUiVersion, installVersion } from "./versions";

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

/** The core's install scripts, downloaded by the build (outside asar). */
const CORE_SCRIPTS = app.isPackaged
  ? join(process.resourcesPath, "core-scripts")
  : join(__dirname, "..", "core-scripts");

const pkg = JSON.parse(
  readFileSync(join(app.getAppPath(), "package.json"), "utf8")
) as {
  evoscientist: { coreRange: string; protocols: number[]; uiPort: number };
};
const manifest: Manifest = {
  coreRange: pkg.evoscientist.coreRange,
  protocols: pkg.evoscientist.protocols,
  // Without a readable bundle the app's own version stands in; the launch
  // then stops at the missing server.js anyway.
  uiVersion: bundledUiVersion(UI_SERVER_JS) ?? app.getVersion(),
};

/** The core version the bundled install script installs (D11). */
const INSTALL_VERSION = installVersion(manifest.coreRange);

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

let win: BrowserWindow | null = null;

const uiRecord = () => uiRecordPath(app.getPath("userData"));
const userFile = (name: string) => join(app.getPath("userData"), name);

/** The first-launch mirror answer, kept in userData (`mirror.json`). */
function readKeptMirror(): boolean | null {
  try {
    const v = JSON.parse(readFileSync(userFile("mirror.json"), "utf8")) as {
      cn?: unknown;
    };
    return typeof v.cn === "boolean" ? v.cn : null;
  } catch {
    return null;
  }
}

/** App updates from GitHub Releases (W04): only an installed Windows app
 *  updates itself; macOS packaging is W06. electron-updater's own lines go
 *  to desktop.log too. */
const appUpdate =
  app.isPackaged && process.platform === "win32"
    ? createAppUpdate({
        updater: (() => {
          autoUpdater.autoDownload = false;
          autoUpdater.autoInstallOnAppQuit = false;
          autoUpdater.logger = {
            info: (m: unknown) => log.info(`updater: ${m}`),
            warn: (m: unknown) => log.warn(`updater: ${m}`),
            error: (m: unknown) => log.warn(`updater: ${brief(m)}`),
            debug: () => {},
          };
          return autoUpdater;
        })(),
        newToken: () => new CancellationToken(),
        online: () => net.isOnline(),
        log,
        onChange: (s) => desktop.updateChanged(s),
      })
    : null;

const desktop = createApp({
  appVersion: app.getVersion(),
  platform: process.platform,
  env: process.env,
  manifest,
  uiPort: pkg.evoscientist.uiPort,
  folders,
  childEnv,
  runtimeDir: runtimeDir(),
  uiServerJs: UI_SERVER_JS,
  uiEntry: UI_ENTRY,
  execPath: process.execPath,
  bundledUiVersion: () => bundledUiVersion(UI_SERVER_JS),
  log,
  uiLog,

  messageBox: (opts) =>
    win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts),
  chooseFolder: async (title) => {
    const opts = {
      title,
      properties: ["openDirectory", "createDirectory"] as (
        | "openDirectory"
        | "createDirectory"
      )[],
    };
    const r = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
  openPath: (p) => void shell.openPath(p),
  showItemInFolder: (p) => shell.showItemInFolder(p),
  copyText: (t) => clipboard.writeText(t),
  documentsDir: () => app.getPath("documents"),
  exit: (relaunch) => {
    if (relaunch) app.relaunch();
    app.exit(0);
  },

  fileExists: existsSync,
  ensureDir: (p) => void mkdirSync(p, { recursive: true }),
  recordEvoSci: (found) => {
    try {
      writeFileSync(
        join(app.getPath("userData"), "evosci.json"),
        JSON.stringify({ ...found, recorded: new Date().toISOString() })
      );
    } catch (e) {
      log.warn(`cannot record the EvoSci path: ${e}`);
    }
  },
  readUiRecord: () => readUiRecord(uiRecord()),
  writeUiRecord: (r) => writeUiRecord(uiRecord(), r),
  writeCrashReport,
  readStartConfig: () => readStartConfig(folders.configDir, process.env),

  locateEvoSci: () =>
    locateEvoSci({
      dataDir: folders.dataDir,
      env: childEnv,
      toolBinDir: uvToolBinDir(childEnv, folders.dataDir),
    }),
  runCollect: (file, args, cwd, timeoutMs) =>
    runCollect(file, args, { cwd, env: childEnv, timeoutMs, log }),
  startDeploy: (file, workspace) =>
    startDeploy(file, workspace, childEnv, { log }),
  pickUiPort,
  startUiServer,
  uiServerEnv: (target) => uiServerEnv(process.env, target),
  stopLeftoverUi: (record) =>
    stopLeftoverUi(record, {
      startTime: (pid) => processStartTime(pid),
      kill: (pid) => killTree(pid, log),
      log,
    }),
  processStartTime: (pid) => processStartTime(pid),

  keptMirror: readKeptMirror,
  keepMirror: (cn) => {
    try {
      writeFileSync(userFile("mirror.json"), JSON.stringify({ cn }));
    } catch (e) {
      log.warn(`cannot keep the mirror answer: ${e}`);
    }
  },
  windowsArm64: () =>
    isWindowsArm64(
      (file, args) =>
        runCollect(file, args, {
          cwd: process.env.SystemRoot ?? folders.dataDir,
          env: process.env,
          timeoutMs: 15_000,
          log,
        }),
      log
    ),
  updateLockHeld: () => updateLockHeld(folders.dataDir, process.platform),
  backupConfig: () => backupConfig(folders.configDir),
  runInstall: (cn, onLine) => {
    if (!INSTALL_VERSION)
      throw new Error(
        `the core range ${manifest.coreRange} names no version to install`
      );
    return runInstallScript(
      installCommand({
        platform: process.platform,
        scriptsDir: CORE_SCRIPTS,
        version: INSTALL_VERSION,
        cn,
        env: childEnv,
      }),
      { cwd: folders.dataDir, log, onLine }
    );
  },
  runSetup: (file, cn, stages, onUpdate) =>
    runSetup(file, {
      cn,
      stages,
      cwd: folders.dataDir,
      env: childEnv,
      log,
      onUpdate,
    }),
  readSetupRecord: () =>
    readSetupRecord(userFile("setup.json"), folders.dataDir),
  writeSetupRecord: (v) => {
    // A setup that worked still counts when its record cannot be written;
    // the next launch then runs setup again.
    try {
      writeSetupRecord(userFile("setup.json"), v, folders.dataDir);
    } catch (e) {
      log.warn(`cannot record the setup: ${e}`);
    }
  },

  // Electron's net follows the system proxy, PAC files and the Windows
  // certificate store; Node's own fetch follows none of them.
  lookupRelease: (cn) =>
    lookupNewest({
      fetch: (url, init) => net.fetch(url, init),
      cn,
      range: manifest.coreRange,
    }),
  runUpdate: (file, version, stages, onUpdate) =>
    runUpdate(file, {
      version,
      stages,
      cwd: folders.dataDir,
      env: childEnv,
      log,
      onUpdate,
    }),
  backendAnswers: async (port) =>
    (await answers(`http://127.0.0.1:${port}/ok`, 2_000)) === 200,
  uvToolEnvExists: () =>
    uvToolEnvExists({
      dataDir: folders.dataDir,
      env: childEnv,
      toolDir: uvToolDir(childEnv, folders.dataDir),
    }),

  appUpdate,

  checkWork: (url) => checkWork(backendRequest(url)),
  waitForMemoryWorkers: (url, cancelled) =>
    waitForMemoryWorkers(backendRequest(url), { cancelled }),
});

/** The window as the controller drives it. */
function appWindow(w: BrowserWindow): AppWindow {
  return {
    loadStatusPage: () => w.loadFile(STATUS_HTML),
    sendScreen: (s) => w.webContents.send("status:screen", s),
    loadUrl: (url) => w.loadURL(url),
    currentUrl: () => w.webContents.getURL(),
    bringToFront: () => {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    },
    focus: () => w.focus(),
    hideAll: () => {
      const shown = BrowserWindow.getAllWindows().filter((x) => x.isVisible());
      for (const x of shown) x.hide();
      return () => {
        for (const x of shown) if (!x.isDestroyed()) x.show();
      };
    },
    // Each page's preload listens on its own channel.
    sendUpdate: (state, offer) => {
      w.webContents.send("desktop:update", state);
      w.webContents.send("status:update", offer);
    },
  };
}

// --- Window ---------------------------------------------------------------------

/** Keeps every window on the UI's origin: other links open in the system browser. */
function guard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = classifyLink(url, desktop.uiOrigin());
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
    const target = classifyLink(url, desktop.uiOrigin());
    if (target === "app") return;
    e.preventDefault();
    if (target === "browser") void shell.openExternal(url);
    else log.info(`blocked navigation to ${url}`);
  });
}

/** The one app window, hidden instead of closed until the app exits. */
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
    if (desktop.exiting) return;
    e.preventDefault();
    void desktop.requestQuit();
  });
  w.on("query-session-end", (e) => desktop.querySessionEnd(e.reasons));
  w.on("session-end", (e) =>
    desktop.endOfSession(`session-end (${e.reasons.join(",")})`)
  );
  const contents = w.webContents;
  contents.on("render-process-gone", (_e, d) => {
    log.warn(`renderer gone: ${d.reason} (exit code ${d.exitCode})`);
    if (d.reason === "clean-exit" || desktop.exiting) return;
    void desktop.nativeError(
      "renderer_gone",
      `The window's renderer process ended: ${d.reason} (exit code ${d.exitCode}).`
    );
  });
  contents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a newer navigation replaced this one.
    if (!isMainFrame || code === -3 || desktop.exiting) return;
    log.warn(`did-fail-load ${code} ${description} ${url}`);
    void desktop.nativeError(
      "renderer_gone",
      `The window could not load ${url}: ${description} (${code}).`
    );
  });
  contents.on("preload-error", (_e, path, error) => {
    log.warn(`preload error in ${path}: ${error.stack ?? error}`);
    void desktop.nativeError(
      "renderer_gone",
      `The preload script failed: ${error}`
    );
  });
  return w;
}

/** The app menu: File (Restart backend, Open log folder, Quit), Edit, View and Window. */
function buildMenu(): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Restart backend",
          click: () => void desktop.restartBackend(),
        },
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

// --- Status page actions, the URL handover and the bridge ---------------------

const fromStatusPage = (e: IpcMainEvent | IpcMainInvokeEvent) =>
  e.senderFrame?.url.startsWith("file:") === true;

/** The IPC the status page and the preload use; each channel answers only its own kind of page. */
function registerIpc(): void {
  ipcMain.handle("status:get", (e) =>
    fromStatusPage(e) ? desktop.screen : null
  );
  ipcMain.handle("status:act", (e, id: ActionId, arg: unknown) =>
    fromStatusPage(e) ? desktop.act(id, arg) : undefined
  );
  // D6: the preload asks synchronously, before any page script runs, and
  // merges the URL into the WebUI's saved config. Only the UI's own origin
  // gets it.
  ipcMain.on("desktop:backend-url", (e) => {
    e.returnValue = desktop.backendUrlFor(senderOrigin(e));
  });
  // W03d: the bridge for the WebUI (`src/lib/desktop.ts`), also only for the
  // UI's own origin.
  ipcMain.on("desktop:default-folder", (e) => {
    e.returnValue = desktop.defaultFolderFor(senderOrigin(e));
  });
  ipcMain.handle("desktop:restart-backend", (e) =>
    desktop.restartFor(senderOrigin(e))
  );
  // W04: the app update, for the WebUI page and the status page.
  ipcMain.handle("desktop:update-state", (e) =>
    desktop.updateFor(senderOrigin(e), fromStatusPage(e))
  );
  ipcMain.handle("status:update-offer", (e) =>
    desktop.updateOfferFor(fromStatusPage(e))
  );
  ipcMain.handle("desktop:update-download", (e) =>
    desktop.downloadUpdateFor(senderOrigin(e), fromStatusPage(e))
  );
  ipcMain.handle("desktop:update-restart", (e) =>
    desktop.restartToUpdateFor(senderOrigin(e), fromStatusPage(e))
  );
}

/** The origin of the frame that sent an IPC message, or null. */
function senderOrigin(e: IpcMainEvent | IpcMainInvokeEvent): string | null {
  try {
    return e.senderFrame ? new URL(e.senderFrame.url).origin : null;
  } catch {
    return null;
  }
}

// --- Start -------------------------------------------------------------------

/** Logs the start, wires the app's events and opens the window. */
function start(): void {
  log.info(
    `EvoScientist desktop ${app.getVersion()} (Electron ${
      process.versions.electron
    }, ${process.platform} ${process.arch}), WebUI ${
      manifest.uiVersion
    }, core range ${manifest.coreRange} (installs ${INSTALL_VERSION ?? "none"})`
  );
  log.info(`data ${folders.dataDir}, config ${folders.configDir}`);
  process.on("uncaughtException", (e) => {
    log.warn(`uncaught: ${e.stack ?? e}`);
    const report = desktop.crashReport("uncaught_exception", String(e));
    dialog.showErrorBox(
      "EvoScientist",
      `${e}${report ? `\n\nCrash report: ${report}` : ""}`
    );
  });
  process.on("unhandledRejection", (e) =>
    log.warn(`unhandled rejection: ${e instanceof Error ? e.stack : e}`)
  );

  app.on("second-instance", () => desktop.secondInstance());
  app.on("before-quit", (e) => {
    if (desktop.exiting) return;
    e.preventDefault();
    void desktop.requestQuit();
  });
  // The window is hidden, never closed, until the app exits.
  app.on("window-all-closed", () => {});
  app.on("web-contents-created", (_e, contents) => guard(contents));

  void app.whenReady().then(() => {
    if (process.platform !== "win32")
      powerMonitor.on("shutdown", () => desktop.endOfSession("shutdown"));
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
    desktop.attachWindow(appWindow(win));
    desktop.start();
  });
}

if (app.requestSingleInstanceLock()) start();
else app.exit(0);
