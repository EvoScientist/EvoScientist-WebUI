import type { MessageBoxOptions } from "electron";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps, type AppLog, type AppWindow } from "./app";
import type { MemoryWaitResult, WorkCheck } from "./closeCheck";
import type { DeployOutcome, DeploySession } from "./deploy";
import type { DeployError, DeployReady } from "./lines";
import type { Collected, ExitInfo } from "./proc";
import type { InstallRun } from "./install";
import { SessionEnd } from "./sessionEnd";
import type { SetupRun, Stage } from "./setup";
import type { UiServer } from "./uiServer";

const READY: DeployReady = {
  event: "ready",
  url: "http://127.0.0.1:6174",
  owned: true,
  workspace: "/docs/EvoScientist",
  dataDir: "/data",
  configDir: "/config",
  logFile: "/runtime/logs/langgraph_dev.log",
  warnings: [],
};
const NO_WORK = {
  kind: "known" as const,
  busyThreads: 0,
  threadIds: [] as string[],
  jobs: [],
  scheduledTasks: 0,
};
const BUSY: WorkCheck = { ...NO_WORK, busyThreads: 2, threadIds: ["t1", "t2"] };

const ok = (stdout: string[], code = 0): Collected => ({
  timedOut: false,
  code,
  stdout,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeLog(name: string): AppLog & { lines: string[]; moved: string[] } {
  const lines: string[] = [];
  const moved: string[] = [];
  return {
    lines,
    moved,
    path: `/runtime/${name}`,
    folder: "/runtime",
    info: (m) => void lines.push(`INFO ${m}`),
    warn: (m) => void lines.push(`WARN ${m}`),
    moveTo: (d) => void moved.push(d),
    close: () => {},
  };
}

/** A `deploy` stand-in: ready at once; `lose` reports a lost backend. */
function fakeSession(ready: DeployReady = READY) {
  const lost: ((e: DeployError) => void)[] = [];
  const stopped = { count: 0, gate: null as Promise<void> | null };
  const s: DeploySession & {
    lose(e?: Partial<DeployError>): void;
    stopped: typeof stopped;
    stdinClosed: number;
  } = {
    outcome: Promise.resolve<DeployOutcome>({ kind: "ready", ready }),
    onLost: (cb) => void lost.push(cb),
    stop: async () => {
      stopped.count++;
      if (stopped.gate) await stopped.gate;
      return "stopped";
    },
    closeStdinNow: () => void s.stdinClosed++,
    pid: 100,
    lose: (e = {}) =>
      lost.forEach((cb) =>
        cb({
          event: "error",
          code: "backend_exited",
          message: "The backend exited.",
          detail: {},
          ...e,
        })
      ),
    stopped,
    stdinClosed: 0,
  };
  return s;
}

function fakeUi(port: number) {
  const exited = deferred<ExitInfo>();
  const ui: UiServer & { stops: number; stdinClosed: number } = {
    url: `http://127.0.0.1:${port}/`,
    port,
    exited: exited.promise,
    whenAnswering: async () => {},
    stop: async () => {
      ui.stops++;
      exited.resolve({ code: 0, signal: null });
    },
    closeStdinNow: () => void ui.stdinClosed++,
    pid: 200,
    stops: 0,
    stdinClosed: 0,
  };
  return { ui, exit: (code: number) => exited.resolve({ code, signal: null }) };
}

function fakeWindow() {
  const calls: string[] = [];
  let page = "";
  const shownAgain = vi.fn();
  const w: AppWindow & {
    calls: string[];
    shownAgain: typeof shownAgain;
    navigate(u: string): void;
  } = {
    calls,
    shownAgain,
    loadStatusPage: async () => {
      page = "file:///status.html";
      calls.push("status page");
    },
    sendScreen: (s) => void calls.push(`screen ${s.kind}`),
    loadUrl: async (u) => {
      page = u;
      calls.push(`load ${u}`);
    },
    currentUrl: () => page,
    /** The user moved within the UI. */
    navigate: (u: string) => void (page = u),
    bringToFront: () => void calls.push("front"),
    focus: () => void calls.push("focus"),
    hideAll: () => {
      calls.push("hide");
      return shownAgain;
    },
  };
  return w;
}

function harness(over: Partial<AppDeps> = {}) {
  const log = fakeLog("desktop.log");
  const uiLog = fakeLog("desktop-ui.log");
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const uis: ReturnType<typeof fakeUi>[] = [];
  const win = fakeWindow();
  const exit = vi.fn();
  const messageBox = vi.fn(async (_opts: MessageBoxOptions) => ({
    response: 0,
  }));
  const later: (() => void)[] = [];
  let now = 0;
  const sessionEnd = new SessionEnd(
    () => now,
    (fn) => void later.push(fn)
  );
  const deps: AppDeps = {
    appVersion: "0.4.2",
    platform: "win32",
    env: {},
    manifest: { coreRange: ">=0.3.8,<0.4", protocols: [1], uiVersion: "0.4.2" },
    uiPort: 4718,
    folders: {
      dataDir: "/data",
      configDir: "/config",
      xdgConfigHomeSet: false,
    },
    childEnv: {},
    runtimeDir: "/runtime",
    uiServerJs: "/ui/server.js",
    uiEntry: "/ui-entry.mjs",
    execPath: "/electron",
    bundledUiVersion: () => "0.4.2",
    log,
    uiLog,
    messageBox,
    chooseFolder: async () => null,
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    copyText: vi.fn(),
    documentsDir: () => "/docs",
    exit,
    fileExists: () => true,
    ensureDir: () => {},
    recordEvoSci: () => {},
    readUiRecord: () => null,
    writeUiRecord: () => {},
    writeCrashReport: vi.fn(() => "/runtime/desktop-crash.txt"),
    readStartConfig: () => ({ defaultWorkdir: null, port: 6174, mirror: null }),
    locateEvoSci: async () => ({
      path: "C:\\bin\\EvoSci.exe",
      via: "uv-tool-bin",
    }),
    runCollect: async (_f, args) =>
      args[0] === "--version"
        ? ok([
            JSON.stringify({
              version: "0.3.8",
              protocol: 1,
              webui_compat: ">=0.3,<0.5",
            }),
          ])
        : ok(['{"protocol":1,"stage":"node","status":"done"}']),
    startDeploy: () => {
      const s = fakeSession();
      sessions.push(s);
      return s;
    },
    pickUiPort: async (p) => ({ port: p, fallback: false }),
    startUiServer: (opts) => {
      const u = fakeUi(opts.port);
      uis.push(u);
      return u.ui;
    },
    uiServerEnv: () => ({}),
    stopLeftoverUi: async () => "none",
    processStartTime: async () => null,
    checkWork: async () => NO_WORK,
    waitForMemoryWorkers: async () => "quiet",
    keptMirror: () => null,
    keepMirror: vi.fn(),
    windowsArm64: async () => false,
    updateLockHeld: () => false,
    backupConfig: () => null,
    runInstall: () => installRun(0),
    runSetup: () => setupRun(0, []),
    // Set up before: launches go straight to the node stage.
    readSetupRecord: () => "0.3.8",
    writeSetupRecord: vi.fn(),
    pause: async () => {},
    sessionEnd,
    ...over,
  };
  const app = createApp(deps);
  app.attachWindow(win);
  return {
    app,
    deps,
    log,
    uiLog,
    win,
    exit,
    messageBox,
    sessions,
    uis,
    later,
    setNow: (t: number) => void (now = t),
  };
}

/** An install script or setup stand-in that ends when `finish` is called. */
function pendingRun<T>(result: T) {
  const done = deferred<T>();
  const cancel = vi.fn(async () => done.resolve(result));
  return {
    run: { done: done.promise, cancel },
    finish: () => done.resolve(result),
    cancel,
  };
}

function installRun(code: number, lines: string[] = []): InstallRun {
  return {
    done: Promise.resolve({ exit: { code, signal: null }, lines }),
    cancel: async () => {},
  };
}

function setupRun(code: number, stages: Stage[]): SetupRun {
  return {
    done: Promise.resolve({ exit: { code, signal: null }, stages }),
    cancel: async () => {},
  };
}

const VERSION_LINE = JSON.stringify({
  version: "0.3.8",
  protocol: 1,
  webui_compat: ">=0.3,<0.5",
});

/** A harness on a machine without EvoSci until the install script ran. */
function freshMachine(over: Partial<AppDeps> = {}) {
  const state = { installed: false };
  const h = harness({
    locateEvoSci: async () =>
      state.installed
        ? { path: "C:\\bin\\EvoSci.exe", via: "uv-tool-bin" }
        : null,
    readSetupRecord: () => null,
    runCollect: async (_f, args) =>
      args[0] === "--version"
        ? ok([VERSION_LINE])
        : args[1] === "--manifest"
        ? ok(['{"protocol":1,"stages":[{"id":"node","title":"Node.js"}]}'])
        : ok([]),
    ...over,
  });
  return { ...h, state };
}

/** A harness whose app has launched and shows the UI. */
async function launched(over: Partial<AppDeps> = {}) {
  const h = harness(over);
  await h.app.launch();
  return h;
}

describe("launch", () => {
  it("shows the status page, then loads the UI; logs move next to the backend's", async () => {
    const h = await launched();
    expect(h.win.calls).toEqual([
      "status page",
      "screen progress",
      "screen progress",
      "screen progress",
      "load http://127.0.0.1:4718/",
    ]);
    expect(h.log.moved).toEqual(["/runtime/logs"]);
    expect(h.uiLog.moved).toEqual(["/runtime/logs"]);
    expect(h.app.backendUrlFor("http://127.0.0.1:4718")).toBe(READY.url);
    expect(h.app.backendUrlFor("http://127.0.0.1:9999")).toBeNull();
    expect(h.app.backendUrlFor(null)).toBeNull();
  });

  it("shows a lost backend as an error screen with a crash report", async () => {
    const h = await launched();
    h.sessions[0].lose();
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "backend_exited",
    });
    expect(h.deps.writeCrashReport).toHaveBeenCalledTimes(1);
    expect(h.app.backendUrlFor("http://127.0.0.1:4718")).toBeNull();
  });

  it("shows the UI server's exit after the window loaded it", async () => {
    const h = await launched();
    h.uis[0].exit(3);
    await settle();
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "ui_server_exited",
    });
  });
});

describe("quit", () => {
  it("checks for work, hides, waits for the memory workers, stops the UI server and deploy, exits", async () => {
    const order: string[] = [];
    const h = await launched({
      checkWork: async () => (order.push("check"), NO_WORK),
      waitForMemoryWorkers: async () => (order.push("wait"), "quiet"),
    });
    await h.app.requestQuit();
    expect(order).toEqual(["check", "wait"]);
    expect(h.win.calls.at(-1)).toBe("hide");
    expect(h.uis[0].ui.stops).toBe(1);
    expect(h.sessions[0].stopped.count).toBe(1);
    expect(h.exit).toHaveBeenCalledWith(false);
    expect(h.app.exiting).toBe(true);
    expect(h.messageBox).not.toHaveBeenCalled();
  });

  it("asks when work runs, and Cancel keeps everything running", async () => {
    const h = await launched({ checkWork: async () => BUSY });
    h.messageBox.mockResolvedValueOnce({ response: 1 });
    await h.app.requestQuit();
    expect(h.messageBox).toHaveBeenCalledTimes(1);
    expect(h.win.calls).not.toContain("hide");
    expect(h.sessions[0].stopped.count).toBe(0);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.app.quitState).toBe("none");
  });

  it("a second launch during the memory wait cancels the quit and shows the windows again", async () => {
    let cancelledFn: () => boolean = () => false;
    const waiting = deferred<void>();
    const h = await launched({
      waitForMemoryWorkers: async (_url, cancelled) => {
        cancelledFn = cancelled;
        waiting.resolve();
        while (!cancelledFn()) await settle();
        return "cancelled" as MemoryWaitResult;
      },
    });
    const quit = h.app.requestQuit();
    await waiting.promise;
    expect(h.app.quitState).toBe("waiting");
    h.app.secondInstance();
    await quit;
    expect(h.win.shownAgain).toHaveBeenCalledTimes(1);
    expect(h.win.calls.at(-1)).toBe("focus");
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.sessions[0].stopped.count).toBe(0);
    expect(h.app.quitState).toBe("none");
  });

  it("a second launch while stopping relaunches after the exit", async () => {
    const gate = deferred<void>();
    const h = await launched();
    h.sessions[0].stopped.gate = gate.promise;
    const quit = h.app.requestQuit();
    await vi.waitFor(() => expect(h.sessions[0].stopped.count).toBe(1));
    expect(h.app.quitState).toBe("stopping");
    h.app.secondInstance();
    gate.resolve();
    await quit;
    expect(h.exit).toHaveBeenCalledWith(true);
  });

  it("a reused backend: no work check, no wait, deploy only detaches", async () => {
    const checkWork = vi.fn(async () => BUSY);
    const wait = vi.fn(async () => "quiet" as MemoryWaitResult);
    const h = harness({
      checkWork,
      waitForMemoryWorkers: wait,
      startDeploy: () => {
        const s = fakeSession({ ...READY, owned: false });
        h.sessions.push(s);
        return s;
      },
    });
    await h.app.launch();
    await h.app.requestQuit();
    expect(checkWork).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(h.sessions[0].stopped.count).toBe(1);
    expect(h.exit).toHaveBeenCalledWith(false);
  });

  it("a backend lost while quitting shows nothing", async () => {
    const h = await launched();
    const gate = deferred<void>();
    h.sessions[0].stopped.gate = gate.promise;
    const quit = h.app.requestQuit();
    await vi.waitFor(() => expect(h.sessions[0].stopped.count).toBe(1));
    h.sessions[0].lose();
    gate.resolve();
    await quit;
    expect(h.deps.writeCrashReport).not.toHaveBeenCalled();
    expect(h.app.screen.kind).not.toBe("error");
  });

  it("a second request while quitting does nothing", async () => {
    const h = await launched();
    await Promise.all([h.app.requestQuit(), h.app.requestQuit()]);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});

describe("quit, after the W03a review", () => {
  it("a backend lost during the quit question is shown when the quit is cancelled", async () => {
    const h = await launched({ checkWork: async () => BUSY });
    h.messageBox.mockImplementationOnce(async () => {
      h.sessions[0].lose();
      return { response: 1 };
    });
    await h.app.requestQuit();
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "backend_exited",
    });
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("a backend lost during the quit question is not shown when the quit goes on", async () => {
    const h = await launched({ checkWork: async () => BUSY });
    h.messageBox.mockImplementationOnce(async () => {
      h.sessions[0].lose();
      return { response: 0 };
    });
    await h.app.requestQuit();
    expect(h.app.screen.kind).not.toBe("error");
    expect(h.deps.writeCrashReport).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(false);
  });

  it("a second launch during the last probe cancels whatever the wait returned", async () => {
    const second = { launch: () => {} };
    const h = await launched({
      waitForMemoryWorkers: async () => {
        second.launch();
        return "quiet";
      },
    });
    second.launch = () => h.app.secondInstance();
    await h.app.requestQuit();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.win.shownAgain).toHaveBeenCalledTimes(1);
  });

  it("a quit waits for the deploy a restart is stopping", async () => {
    const gate = deferred<void>();
    const h = await launched();
    h.sessions[0].stopped.gate = gate.promise;
    const restart = h.app.restartBackend();
    await vi.waitFor(() => expect(h.sessions[0].stopped.count).toBe(1));
    const quit = h.app.requestQuit();
    await settle();
    expect(h.exit).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([quit, restart]);
    expect(h.exit).toHaveBeenCalledWith(false);
    // The restart saw the quit and started no new backend.
    expect(h.sessions).toHaveLength(1);
  });
});

describe("the page the user was on", () => {
  it("Restart backend brings back the same page in the same folder", async () => {
    const h = await launched();
    h.win.navigate("http://127.0.0.1:4718/?threadId=t1#end");
    await h.app.restartBackend();
    expect(h.win.calls.at(-1)).toBe(
      "load http://127.0.0.1:4718/?threadId=t1#end"
    );
  });

  it("a new folder starts at the UI's root", async () => {
    let folder = "/docs/EvoScientist";
    const h = harness({
      startDeploy: () => {
        const s = fakeSession({ ...READY, workspace: folder });
        h.sessions.push(s);
        return s;
      },
    });
    await h.app.launch();
    h.win.navigate("http://127.0.0.1:4718/?threadId=t1");
    folder = "/elsewhere";
    await h.app.restartBackend();
    expect(h.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
  });
});

describe("restart backend", () => {
  it("an owned backend: asks when busy, waits, stops deploy and starts it again", async () => {
    const wait = vi.fn(async () => "quiet" as MemoryWaitResult);
    const h = await launched({
      checkWork: async () => BUSY,
      waitForMemoryWorkers: wait,
    });
    await h.app.restartBackend();
    expect(h.messageBox).toHaveBeenCalledTimes(1);
    expect(h.messageBox.mock.calls[0][0]).toMatchObject({
      buttons: ["Restart backend", "Cancel"],
    });
    expect(wait).toHaveBeenCalledWith(READY.url, expect.any(Function));
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0].stopped.count).toBe(1);
    expect(h.app.backendUrlFor("http://127.0.0.1:4718")).toBe(READY.url);
  });

  it("Cancel changes nothing", async () => {
    const h = await launched({ checkWork: async () => BUSY });
    h.messageBox.mockResolvedValueOnce({ response: 1 });
    await h.app.restartBackend();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].stopped.count).toBe(0);
  });

  it("a reused backend: says so and changes nothing", async () => {
    const h = harness({
      startDeploy: () => {
        const s = fakeSession({ ...READY, owned: false });
        h.sessions.push(s);
        return s;
      },
    });
    await h.app.launch();
    await h.app.restartBackend();
    expect(h.messageBox.mock.calls[0][0]).toMatchObject({
      message: "This backend was started outside the app.",
    });
    expect(h.messageBox.mock.calls[0][0].detail).toMatch(
      /run EvoSci server stop in a terminal, then press Retry/
    );
    expect(h.messageBox.mock.calls[0][0].detail).toMatch(
      /ends running work in every project/
    );
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].stopped.count).toBe(0);
  });

  it("a backend lost while the question was open starts a new one", async () => {
    const h = await launched({ checkWork: async () => BUSY });
    h.messageBox.mockImplementationOnce(async () => {
      h.sessions[0].lose();
      return { response: 0 };
    });
    await h.app.restartBackend();
    expect(h.sessions).toHaveLength(2);
    expect(h.app.backendUrlFor("http://127.0.0.1:4718")).toBe(READY.url);
  });
});

describe("restart from the page (bridge)", () => {
  /** A harness whose next `deploy` answers `next()` instead of READY. */
  async function launchedWith(next: () => DeployOutcome) {
    let first = true;
    const h = harness({
      startDeploy: () => {
        const s = fakeSession();
        if (!first) s.outcome = Promise.resolve(next());
        first = false;
        h.sessions.push(s);
        return s;
      },
    });
    await h.app.launch();
    expect(h.app.screen.kind).not.toBe("error");
    return h;
  }

  it("same backend URL and folder: the page stays and the result is ok at the new ready", async () => {
    const h = await launched();
    h.win.navigate("http://127.0.0.1:4718/?view=setup");
    const before = h.win.calls.length;
    await expect(h.app.restartFromPage()).resolves.toEqual({ ok: true });
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0].stopped.count).toBe(1);
    // No status page, no reload, the same UI server.
    expect(h.win.calls.slice(before)).toEqual([]);
    expect(h.uis).toHaveLength(1);
    expect(h.uis[0].ui.stops).toBe(0);
    expect(h.app.backendUrlFor("http://127.0.0.1:4718")).toBe(READY.url);
  });

  it("a new port: the UI server restarts and the page loads again", async () => {
    const h = await launchedWith(() => ({
      kind: "ready",
      ready: { ...READY, url: "http://127.0.0.1:6200" },
    }));
    h.win.navigate("http://127.0.0.1:4718/?view=settings");
    await expect(h.app.restartFromPage()).resolves.toEqual({ ok: true });
    expect(h.uis).toHaveLength(2);
    expect(h.uis[0].ui.stops).toBe(1);
    expect(h.win.calls.at(-1)).toBe(
      "load http://127.0.0.1:4718/?view=settings"
    );
    expect(h.app.backendUrlFor("http://127.0.0.1:4718")).toBe(
      "http://127.0.0.1:6200"
    );
  });

  it("a new folder: the page loads at the UI's root", async () => {
    const h = await launchedWith(() => ({
      kind: "ready",
      ready: { ...READY, workspace: "/elsewhere" },
    }));
    h.win.navigate("http://127.0.0.1:4718/?view=settings");
    const before = h.win.calls.length;
    await expect(h.app.restartFromPage()).resolves.toEqual({ ok: true });
    expect(h.win.calls.slice(before)).toEqual(["load http://127.0.0.1:4718/"]);
  });

  it("a start that fails shows the error screen and answers its code", async () => {
    const h = await launchedWith(() => ({
      kind: "error",
      error: {
        event: "error",
        code: "port_conflict",
        message: "Port 6200 is taken.",
        detail: {},
      },
    }));
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "port_conflict",
    });
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "port_conflict",
    });
  });

  it("Cancel on the busy check answers cancelled and changes nothing", async () => {
    const h = await launched({ checkWork: async () => BUSY });
    h.messageBox.mockResolvedValueOnce({ response: 1 });
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "cancelled",
    });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].stopped.count).toBe(0);
  });

  it("a reused backend answers not_owned without a dialog", async () => {
    const h = harness({
      startDeploy: () => {
        const s = fakeSession({ ...READY, owned: false });
        h.sessions.push(s);
        return s;
      },
    });
    await h.app.launch();
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "not_owned",
    });
    expect(h.messageBox).not.toHaveBeenCalled();
    expect(h.sessions[0].stopped.count).toBe(0);
  });

  it("answers busy while another restart runs, and restarts nothing more", async () => {
    const gate = deferred<void>();
    const h = await launched();
    h.sessions[0].stopped.gate = gate.promise;
    const menu = h.app.restartBackend();
    await vi.waitFor(() => expect(h.sessions[0].stopped.count).toBe(1));
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "busy",
    });
    gate.resolve();
    await menu;
    expect(h.sessions).toHaveLength(2);
  });

  it("serves only the UI's own origin", async () => {
    const h = await launched();
    await expect(h.app.restartFor("http://127.0.0.1:9999")).resolves.toEqual({
      ok: false,
      code: "not_allowed",
    });
    await expect(h.app.restartFor(null)).resolves.toEqual({
      ok: false,
      code: "not_allowed",
    });
    expect(h.sessions).toHaveLength(1);
    await expect(h.app.restartFor("http://127.0.0.1:4718")).resolves.toEqual({
      ok: true,
    });
    expect(h.sessions).toHaveLength(2);
  });

  it("defaultFolder is Documents/EvoScientist, for the UI's origin only", async () => {
    const h = await launched();
    expect(h.app.defaultFolderFor("http://127.0.0.1:4718")).toBe(
      join("/docs", "EvoScientist")
    );
    expect(h.app.defaultFolderFor("http://127.0.0.1:9999")).toBeNull();
    expect(h.app.defaultFolderFor(null)).toBeNull();
  });

  it("no defaultFolder when the Documents folder cannot be resolved", async () => {
    let documents = true;
    const h = await launched({
      documentsDir: () => {
        if (documents) return "/docs";
        throw new Error("Failed to get 'documents' path");
      },
    });
    documents = false;
    expect(h.app.defaultFolderFor("http://127.0.0.1:4718")).toBeNull();
    expect(h.log.lines.at(-1)).toMatch(/^WARN no default folder/);
  });

  it("asks again for work started during the wait, and Cancel stops nothing", async () => {
    const gate = deferred<void>();
    let work: WorkCheck = NO_WORK;
    const checks = vi.fn(async () => work);
    const h = await launched({
      checkWork: checks,
      waitForMemoryWorkers: async () => (await gate.promise, "quiet"),
    });
    h.messageBox.mockResolvedValueOnce({ response: 1 });
    const result = h.app.restartFromPage();
    await settle();
    // The page stays usable: the user starts a chat during the wait.
    work = BUSY;
    gate.resolve();
    await expect(result).resolves.toEqual({ ok: false, code: "cancelled" });
    expect(checks).toHaveBeenCalledTimes(2);
    expect(h.messageBox).toHaveBeenCalledTimes(1);
    expect(h.messageBox.mock.calls[0][0].detail).toContain(
      "2 chats are still running."
    );
    expect(h.sessions[0].stopped.count).toBe(0);
  });

  it("does not ask twice about the work the user already answered for", async () => {
    const checks = vi.fn(async () => BUSY);
    const h = await launched({ checkWork: checks });
    await expect(h.app.restartFromPage()).resolves.toEqual({ ok: true });
    expect(checks).toHaveBeenCalledTimes(2);
    expect(h.messageBox).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].stopped.count).toBe(1);
  });

  it("answers ui_server_exited when only the UI server fails after a new port", async () => {
    const h = await launchedWith(() => ({
      kind: "ready",
      ready: { ...READY, url: "http://127.0.0.1:6200" },
    }));
    h.deps.startUiServer = () => {
      throw new Error("no UI server");
    };
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "ui_server_exited",
    });
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "ui_server_exited",
    });
  });

  it("answers internal_error when the restart throws", async () => {
    const h = await launched({
      waitForMemoryWorkers: async () => {
        throw new Error("boom");
      },
    });
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "internal_error",
    });
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "internal_error",
    });
  });

  it("answers busy once a quit has begun", async () => {
    const gate = deferred<void>();
    const h = await launched({
      waitForMemoryWorkers: async () => (await gate.promise, "quiet"),
    });
    const quit = h.app.requestQuit();
    await vi.waitFor(() => expect(h.app.quitState).not.toBe("none"));
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "busy",
    });
    gate.resolve();
    await quit;
    expect(h.sessions).toHaveLength(1);
  });

  it("a step that needs the status page shows it, then the page comes back", async () => {
    let record: string | null = "0.3.8";
    const h = await launched({
      readSetupRecord: () => record,
      runCollect: async (_f, args) =>
        args[0] === "--version"
          ? ok([VERSION_LINE])
          : args[1] === "--manifest"
          ? ok(['{"protocol":1,"stages":[{"id":"node","title":"Node.js"}]}'])
          : ok([]),
    });
    h.win.navigate("http://127.0.0.1:4718/?view=settings");
    // The core changed since the last setup: the restart runs setup.
    record = null;
    const before = h.win.calls.length;
    await expect(h.app.restartFromPage()).resolves.toEqual({ ok: true });
    const after = h.win.calls.slice(before);
    expect(after[0]).toBe("status page");
    expect(after.at(-1)).toBe("load http://127.0.0.1:4718/?view=settings");
  });

  it("a menu restart after a page restart shows the status page again", async () => {
    const h = await launched();
    await h.app.restartFromPage();
    const before = h.win.calls.length;
    await h.app.restartBackend();
    expect(h.win.calls.slice(before)[0]).toBe("status page");
  });

  it("the menu's restart still shows the status page", async () => {
    const h = await launched();
    const before = h.win.calls.length;
    await h.app.restartBackend();
    expect(h.win.calls.slice(before)[0]).toBe("status page");
  });

  it("a second call while the restart runs waits for it", async () => {
    const gate = deferred<void>();
    const h = await launched({
      waitForMemoryWorkers: async () => (await gate.promise, "quiet"),
    });
    const first = h.app.restartFromPage();
    await settle();
    const second = h.app.restartFromPage();
    gate.resolve();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(h.sessions).toHaveLength(2);
    await expect(h.app.restartFromPage()).resolves.toEqual({ ok: true });
    expect(h.sessions).toHaveLength(3);
  });

  it("a backend lost during the wait starts a new one without a second question", async () => {
    const gate = deferred<void>();
    let lost = false;
    const h = await launched({
      checkWork: async () =>
        lost ? { kind: "unknown", reason: "fetch failed" } : BUSY,
      waitForMemoryWorkers: async () => (await gate.promise, "unreachable"),
    });
    const result = h.app.restartFromPage();
    await settle();
    lost = true;
    h.sessions[0].lose();
    gate.resolve();
    await expect(result).resolves.toEqual({ ok: true });
    expect(h.messageBox).toHaveBeenCalledTimes(1);
    expect(h.sessions).toHaveLength(2);
  });

  it("a backend lost during the second check is not asked about", async () => {
    const second = deferred<WorkCheck>();
    let calls = 0;
    const h = await launched({
      checkWork: async () => (++calls === 1 ? BUSY : second.promise),
    });
    const result = h.app.restartFromPage();
    await vi.waitFor(() => expect(calls).toBe(2));
    h.sessions[0].lose();
    second.resolve({ kind: "unknown", reason: "fetch failed" });
    await expect(result).resolves.toEqual({ ok: true });
    expect(h.messageBox).toHaveBeenCalledTimes(1);
    expect(h.sessions).toHaveLength(2);
  });

  it("Cancel at the second question brings back a page the UI server lost", async () => {
    let work: WorkCheck = BUSY;
    const h = await launched({ checkWork: async () => work });
    h.messageBox
      .mockImplementationOnce(async () => {
        h.uis[0].exit(1);
        await settle();
        work = { ...BUSY, busyThreads: 1, threadIds: ["t3"] };
        return { response: 0 };
      })
      .mockResolvedValueOnce({ response: 1 });
    await expect(h.app.restartFromPage()).resolves.toEqual({
      ok: false,
      code: "cancelled",
    });
    expect(h.messageBox).toHaveBeenCalledTimes(2);
    expect(h.sessions[0].stopped.count).toBe(0);
    expect(h.uis).toHaveLength(2);
    expect(h.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
  });

  it("a quit during the wait answers busy and restarts nothing", async () => {
    const gate = deferred<void>();
    const h = await launched({
      waitForMemoryWorkers: async () => (await gate.promise, "quiet"),
    });
    const result = h.app.restartFromPage();
    await settle();
    const quit = h.app.requestQuit();
    await vi.waitFor(() => expect(h.app.quitState).not.toBe("none"));
    gate.resolve();
    await expect(result).resolves.toEqual({ ok: false, code: "busy" });
    expect(h.log.lines.some((l) => l.includes("after the wait"))).toBe(false);
    await quit;
    expect(h.sessions).toHaveLength(1);
  });

  it("a quit while the second question is open answers busy", async () => {
    let work: WorkCheck = NO_WORK;
    const gate = deferred<void>();
    const answer = deferred<{ response: number }>();
    const h = await launched({
      checkWork: async () => work,
      waitForMemoryWorkers: async () => (await gate.promise, "quiet"),
    });
    h.messageBox.mockImplementationOnce(() => answer.promise);
    const result = h.app.restartFromPage();
    await settle();
    work = BUSY;
    gate.resolve();
    await vi.waitFor(() => expect(h.messageBox).toHaveBeenCalledTimes(1));
    const quit = h.app.requestQuit();
    await vi.waitFor(() => expect(h.app.quitState).not.toBe("none"));
    answer.resolve({ response: 0 });
    await expect(result).resolves.toEqual({ ok: false, code: "busy" });
    await quit;
    expect(h.sessions).toHaveLength(1);
  });
});

describe("end of the session", () => {
  it("closes both stdin pipes once, and a quit after it skips the question and the wait", async () => {
    const wait = vi.fn(async () => "quiet" as MemoryWaitResult);
    const h = await launched({
      checkWork: async () => BUSY,
      waitForMemoryWorkers: wait,
    });
    h.app.endOfSession("session-end (logoff)");
    h.app.endOfSession("session-end (logoff)");
    expect(h.sessions[0].stdinClosed).toBe(1);
    expect(h.uis[0].ui.stdinClosed).toBe(1);
    await h.app.requestQuit();
    expect(h.messageBox).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalled();
  });

  it("a backend lost right after the session-end question is dropped when the session ends", async () => {
    const h = await launched();
    h.setNow(1_000);
    h.app.querySessionEnd(["logoff"]);
    h.sessions[0].lose();
    expect(h.app.screen.kind).not.toBe("error");
    h.app.endOfSession("session-end (logoff)");
    h.later.forEach((fn) => fn());
    expect(h.app.screen.kind).not.toBe("error");
    expect(h.deps.writeCrashReport).not.toHaveBeenCalled();
  });

  it("shows it after the grace period when the sign-out was cancelled", async () => {
    const h = await launched();
    h.app.querySessionEnd(["logoff"]);
    h.sessions[0].lose();
    expect(h.app.screen.kind).not.toBe("error");
    h.later.forEach((fn) => fn());
    expect(h.app.screen).toMatchObject({
      kind: "error",
      code: "backend_exited",
    });
  });
});

describe("second launch", () => {
  it("brings the window to the front", async () => {
    const h = await launched();
    h.app.secondInstance();
    expect(h.win.calls.at(-1)).toBe("front");
  });
});

describe("status page actions", () => {
  /** A core older than the range: its screen has the install command. */
  async function onError(over: Partial<AppDeps> = {}) {
    const h = harness({
      runCollect: async (_f, args) =>
        args[0] === "--version"
          ? ok([VERSION_LINE.replace("0.3.8", "0.3.7")])
          : ok([]),
      ...over,
    });
    await h.app.launch();
    expect(h.app.screen).toMatchObject({ kind: "error", code: "core_too_old" });
    return h;
  }

  it("copy_command, open_logs and open_config", async () => {
    const h = await onError();
    await h.app.act("copy_command", undefined);
    await h.app.act("open_logs", undefined);
    await h.app.act("open_config", undefined);
    expect(h.deps.copyText).toHaveBeenCalledWith(
      expect.stringContaining("install.ps1")
    );
    expect(h.deps.openPath).toHaveBeenNthCalledWith(1, "/runtime");
    expect(h.deps.openPath).toHaveBeenNthCalledWith(2, "/config");
  });

  it("retry launches again", async () => {
    let version = "0.3.7";
    const h = await onError({
      runCollect: async (_f, args) =>
        args[0] === "--version"
          ? ok([VERSION_LINE.replace("0.3.8", version)])
          : ok([]),
    });
    version = "0.3.8";
    await h.app.act("retry", undefined);
    expect(h.sessions).toHaveLength(1);
    expect(h.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
  });

  it("set_port saves the port with EvoSci config set, then launches; an invalid port is ignored", async () => {
    const calls: string[][] = [];
    const h = await launched({
      runCollect: async (_f, args) => {
        calls.push(args);
        return args[0] === "--version"
          ? ok([
              JSON.stringify({
                version: "0.3.8",
                protocol: 1,
                webui_compat: ">=0.3,<0.5",
              }),
            ])
          : ok([]);
      },
    });
    await h.app.act("set_port", 70000);
    expect(calls.some((a) => a[0] === "config")).toBe(false);
    await h.app.act("set_port", 6200);
    expect(calls).toContainEqual([
      "config",
      "set",
      "langgraph_dev_port",
      "6200",
    ]);
    expect(h.sessions).toHaveLength(2);
  });

  it("a failed config set adds its output to the error screen", async () => {
    const h = await onError({
      runCollect: async (_f, args) =>
        args[0] === "config"
          ? ok(["locked"], 1)
          : ok([VERSION_LINE.replace("0.3.8", "0.3.7")]),
    });
    await h.app.act("set_port", 6200);
    expect(h.app.screen).toMatchObject({ kind: "error", code: "core_too_old" });
    expect((h.app.screen as { lines: string[] }).lines.at(-1)).toBe(
      "Could not save langgraph_dev_port: locked"
    );
  });

  it("quit from the error screen exits without a work check", async () => {
    const checkWork = vi.fn(async () => BUSY);
    const h = await onError({ checkWork });
    await h.app.act("quit", undefined);
    expect(checkWork).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(false);
  });
});

describe("first launch", () => {
  it("asks about mirrors, installs with the answer, sets up and shows the UI", async () => {
    const runInstall = vi.fn((_cn: boolean, onLine: (l: string) => void) => {
      onLine("Downloading uv 0.12.23...");
      f.state.installed = true;
      return installRun(0, ["Downloading uv 0.12.23..."]);
    });
    const f = freshMachine({ runInstall });
    const launch = f.app.launch();
    await vi.waitFor(() =>
      expect(f.app.screen).toMatchObject({ kind: "question" })
    );
    await f.app.act("mirror_cn", undefined);
    await launch;
    expect(f.deps.keepMirror).toHaveBeenCalledWith(true);
    expect(runInstall).toHaveBeenCalledWith(true, expect.any(Function));
    expect(f.deps.writeSetupRecord).toHaveBeenCalledWith("0.3.8");
    expect(f.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
  });

  it("shows the install output on its own screen", async () => {
    const p = pendingRun({ exit: { code: 0, signal: null }, lines: [] });
    const f = freshMachine({
      keptMirror: () => false,
      runInstall: (_cn, onLine) => {
        onLine("Resolved 149 packages");
        return p.run;
      },
    });
    const launch = f.app.launch();
    await vi.waitFor(() =>
      expect(f.app.screen).toMatchObject({
        kind: "install",
        output: ["Resolved 149 packages"],
      })
    );
    f.state.installed = true;
    p.finish();
    await launch;
  });

  it("closing during the install asks; Cancel lets it go on, Quit stops its tree and exits", async () => {
    const p = pendingRun({ exit: { code: 1, signal: null }, lines: [] });
    const f = freshMachine({
      keptMirror: () => false,
      runInstall: () => p.run,
    });
    const launch = f.app.launch();
    await vi.waitFor(() => expect(f.app.screen.kind).toBe("install"));
    f.messageBox.mockResolvedValueOnce({ response: 1 });
    await f.app.requestQuit();
    expect(f.messageBox.mock.calls[0][0]).toMatchObject({
      message: "EvoScientist is being installed.",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
    });
    expect(p.cancel).not.toHaveBeenCalled();
    expect(f.exit).not.toHaveBeenCalled();
    await f.app.requestQuit();
    expect(p.cancel).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledWith(false);
    await launch;
    // The killed script's exit is no error to show.
    expect(f.app.screen.kind).not.toBe("error");
    expect(f.deps.writeCrashReport).not.toHaveBeenCalled();
  });

  it("an install that fails during the close question shows its error on Cancel", async () => {
    const p = pendingRun({
      exit: { code: 1, signal: null },
      lines: ["Error: Cannot download x"],
    });
    const f = freshMachine({
      keptMirror: () => false,
      runInstall: () => p.run,
    });
    const launch = f.app.launch();
    await vi.waitFor(() => expect(f.app.screen.kind).toBe("install"));
    f.messageBox.mockImplementationOnce(async () => {
      p.finish();
      await launch;
      return { response: 1 };
    });
    await f.app.requestQuit();
    expect(f.app.screen).toMatchObject({
      kind: "error",
      code: "install_failed",
    });
  });

  it("closing during setup asks with its own text", async () => {
    const p = pendingRun({
      exit: { code: 1, signal: null },
      stages: [] as Stage[],
    });
    const f = freshMachine({ keptMirror: () => false, runSetup: () => p.run });
    f.state.installed = true;
    const launch = f.app.launch();
    await vi.waitFor(() => expect(f.app.screen.kind).toBe("setup"));
    await f.app.requestQuit();
    expect(f.messageBox.mock.calls[0][0]).toMatchObject({
      message: "EvoScientist is being set up.",
    });
    expect(p.cancel).toHaveBeenCalledTimes(1);
    await launch;
    expect(f.exit).toHaveBeenCalled();
  });

  it("Retry with mainland China mirrors installs with -Cn and keeps the choice", async () => {
    const runInstall = vi.fn((_cn: boolean, _onLine: (l: string) => void) =>
      installRun(1, ["Error: x"])
    );
    let kept: boolean | null = false;
    const f = freshMachine({
      keptMirror: () => kept,
      keepMirror: (cn) => void (kept = cn),
      runInstall,
    });
    await f.app.launch();
    expect(f.app.screen).toMatchObject({
      kind: "error",
      code: "install_failed",
      actions: ["retry", "retry_cn", "open_logs"],
    });
    await f.app.act("retry_cn", undefined);
    expect(kept).toBe(true);
    expect(f.app.screen).toMatchObject({
      code: "install_failed",
      actions: ["retry", "open_logs"],
    });
    // A plain Retry later still uses them: the answer was kept.
    await f.app.act("retry", undefined);
    expect(runInstall.mock.calls.map((c) => c[0])).toEqual([false, true, true]);
  });

  it("a plain Retry after Retry with mirrors still uses them over mirror: default in config.yaml", async () => {
    const runInstall = vi.fn((_cn: boolean, _onLine: (l: string) => void) =>
      installRun(1, ["Error: x"])
    );
    const f = freshMachine({
      readStartConfig: () => ({
        defaultWorkdir: null,
        port: 6174,
        mirror: "default",
      }),
      runInstall,
    });
    await f.app.launch();
    await f.app.act("retry_cn", undefined);
    await f.app.act("retry", undefined);
    expect(runInstall.mock.calls.map((c) => c[0])).toEqual([false, true, true]);
  });

  it("Continue after a failed setup starts without it, and records nothing", async () => {
    const stages: Stage[] = [
      { id: "node", title: "Node.js", state: "error", code: "download_failed" },
    ];
    const f = freshMachine({ runSetup: () => setupRun(1, stages) });
    f.state.installed = true;
    await f.app.launch();
    expect(f.app.screen).toMatchObject({
      kind: "error",
      code: "setup_failed",
      actions: ["retry", "retry_cn", "continue", "open_logs"],
    });
    await f.app.act("continue", undefined);
    expect(f.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
    expect(f.deps.writeSetupRecord).not.toHaveBeenCalled();
  });

  it("Continue holds for the session: Restart backend does not run the failed setup again", async () => {
    const stages: Stage[] = [
      { id: "node", title: "Node.js", state: "error", code: "download_failed" },
    ];
    const runSetup = vi.fn(() => setupRun(1, stages));
    const f = freshMachine({ runSetup });
    f.state.installed = true;
    await f.app.launch();
    await f.app.act("continue", undefined);
    await f.app.restartBackend();
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(f.sessions).toHaveLength(2);
    expect(f.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
  });

  it("a setup that ends during the close question: Cancel brings up the UI, with no error", async () => {
    const p = pendingRun({
      exit: { code: 0, signal: null },
      stages: [] as Stage[],
    });
    const f = freshMachine({ keptMirror: () => false, runSetup: () => p.run });
    f.state.installed = true;
    const launch = f.app.launch();
    await vi.waitFor(() => expect(f.app.screen.kind).toBe("setup"));
    f.messageBox.mockImplementationOnce(async () => {
      p.finish();
      await launch;
      return { response: 1 };
    });
    await f.app.requestQuit();
    await vi.waitFor(() =>
      expect(f.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/")
    );
    expect(f.app.screen.kind).not.toBe("error");
    expect(f.deps.writeCrashReport).not.toHaveBeenCalled();
  });

  it("shows a progress screen while setup --manifest runs", async () => {
    const manifest = deferred<Collected>();
    const f = freshMachine({
      runCollect: async (_f, args) =>
        args[0] === "--version"
          ? ok([VERSION_LINE])
          : args[1] === "--manifest"
          ? manifest.promise
          : ok([]),
    });
    f.state.installed = true;
    const launch = f.app.launch();
    await vi.waitFor(() =>
      expect(f.app.screen).toMatchObject({
        kind: "progress",
        title: "Setting up EvoScientist",
        message: "Preparing the setup steps...",
      })
    );
    manifest.resolve(
      ok(['{"protocol":1,"stages":[{"id":"node","title":"Node.js"}]}'])
    );
    await launch;
  });
});

describe("native error", () => {
  it("Reload reloads the UI; Quit quits", async () => {
    const h = await launched();
    await h.app.nativeError("renderer_gone", "gone");
    expect(h.win.calls.at(-1)).toBe("load http://127.0.0.1:4718/");
    h.messageBox.mockResolvedValueOnce({ response: 1 });
    await h.app.nativeError("renderer_gone", "gone");
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalled());
  });
});
