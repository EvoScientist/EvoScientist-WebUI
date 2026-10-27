import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  boot,
  checkCore,
  mirrorChoice,
  resolveWorkspace,
  type BootDeps,
  type BootState,
} from "./boot";
import type { DeployOutcome, DeploySession } from "./deploy";
import type { InstallRun } from "./install";
import type { Collected } from "./proc";
import type { SetupRun, Stage } from "./setup";
import type { UpdateOutcome, UpdateRun, UpdateView } from "./update";

const manifest = {
  coreRange: ">=0.3.8,<0.4",
  protocols: [1],
  uiVersion: "0.4.0",
};
const versionLine = (version = "0.3.8", protocol = 1, compat = ">=0.3,<0.5") =>
  JSON.stringify({ version, protocol, webui_compat: compat });
const ok = (stdout: string[], code = 0): Collected => ({
  timedOut: false,
  code,
  stdout,
});
const READY = {
  event: "ready" as const,
  url: "http://127.0.0.1:6174",
  owned: true,
  workspace: "w",
  dataDir: "d",
  configDir: "c",
  logFile: "l",
  warnings: ["drift"],
};

function session(outcome: DeployOutcome): DeploySession {
  return {
    outcome: Promise.resolve(outcome),
    onLost: () => {},
    stop: async () => "stopped",
    closeStdinNow: () => {},
    pid: 1,
  };
}

function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    manifest,
    platform: "win32",
    log: { info: () => {}, warn: () => {} },
    dataDir: "/data",
    locate: async () => "C:\\bin\\EvoSci.exe",
    runCollect: async (_f, args) =>
      args[0] === "--version"
        ? ok([versionLine()])
        : ok(['{"protocol":1,"stage":"node","status":"done"}']),
    startConfig: () => ({ defaultWorkdir: null, port: 6174, mirror: null }),
    documentsDir: () => "/docs",
    ensureDir: () => {},
    startDeploy: () => session({ kind: "ready", ready: READY }),
    keptMirror: () => null,
    keepMirror: () => {},
    askMirror: async () => false,
    windowsArm64: async () => false,
    updateLockHeld: () => false,
    pause: async () => {},
    stopping: () => false,
    backupConfig: () => null,
    runInstall: () => installRun(0, []),
    runSetup: () => setupRun(0, []),
    // This version was set up before: the node stage runs instead of setup.
    setupRecord: () => "0.3.8",
    recordSetup: () => {},
    askUpdate: async () => {},
    askSeparateInstall: async () => {},
    stopOwnBackend: async () => true,
    lookupRelease: async () => ({ ok: true, version: "0.3.8", url: INDEX }),
    runUpdate: () => updateRun({ kind: "done", version: "0.3.8" }),
    backendAnswers: async () => false,
    uvToolEnvExists: async () => true,
    ...over,
  };
}

const INDEX = "https://pypi.org/simple/evoscientist/";

function updateRun(
  outcome: UpdateOutcome,
  view: UpdateView = { update: {}, stages: [], waiting: null }
): UpdateRun {
  return {
    done: Promise.resolve({ outcome, view }),
    cancelWhenWaiting: () => false,
    waiting: () => false,
  };
}

function installRun(code: number, lines: string[]): InstallRun {
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

const MANIFEST =
  '{"protocol":1,"stages":[{"id":"node","title":"Node.js"},{"id":"research-env","title":"Python research environment"},{"id":"webui","title":"WebUI"}]}';

/** A machine without EvoSci until the install script has run. */
function freshMachine(over: Partial<BootDeps> = {}) {
  let installed = false;
  const calls: string[][] = [];
  const runInstall = vi.fn((_cn: boolean, onLine: (l: string) => void) => {
    onLine("Downloading uv 0.12.23...");
    installed = true;
    return installRun(0, ["Downloading uv 0.12.23..."]);
  });
  const d = deps({
    locate: async () => (installed ? "C:\\bin\\EvoSci.exe" : null),
    runCollect: async (_f, args) => {
      calls.push(args);
      if (args[0] === "--version") return ok([versionLine()]);
      if (args[1] === "--manifest") return ok([MANIFEST]);
      return ok(['{"protocol":1,"stage":"node","status":"done"}']);
    },
    runInstall,
    setupRecord: () => null,
    ...over,
  });
  return { d, runInstall, calls };
}

async function runBoot(d: BootDeps) {
  const states: BootState["phase"][] = [];
  const result = await boot(d, (s) => states.push(s.phase));
  return { result, states };
}

describe("boot", () => {
  it("goes from the core check to ready in Documents/EvoScientist", async () => {
    const startDeploy = vi.fn(() => session({ kind: "ready", ready: READY }));
    const { result, states } = await runBoot(deps({ startDeploy }));
    expect(states).toEqual([
      "checking_core",
      "preparing_node",
      "starting_backend",
      "ready",
    ]);
    expect(result).toMatchObject({
      ok: true,
      core: { version: "0.3.8" },
      workspace: join("/docs", "EvoScientist"),
    });
    expect(startDeploy).toHaveBeenCalledWith(
      "C:\\bin\\EvoSci.exe",
      join("/docs", "EvoScientist")
    );
  });

  it("is version_check_timeout, never a repair, on a timeout", async () => {
    const { result } = await runBoot(
      deps({
        runCollect: async () => ({ timedOut: true, code: null, stdout: [] }),
      })
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "version_check_timeout" },
    });
  });

  it("continues past a failed node stage", async () => {
    const runCollect = vi.fn(async (_f: string, args: string[]) =>
      args[0] === "--version"
        ? ok([versionLine()])
        : ok(
            [
              '{"protocol":1,"stage":"node","status":"error","code":"download_failed"}',
            ],
            1
          )
    );
    const warn = vi.fn();
    const { result } = await runBoot(
      deps({ runCollect, log: { info: () => {}, warn } })
    );
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("download_failed")
    );
    expect(runCollect.mock.calls[1][1]).toEqual([
      "setup",
      "--stage",
      "node",
      "--json",
    ]);
  });

  it("passes deploy's error code through", async () => {
    const { result } = await runBoot(
      deps({
        startDeploy: () =>
          session({
            kind: "error",
            error: {
              event: "error",
              code: "port_conflict",
              message: "m",
              detail: { reason: "foreign" },
            },
          }),
      })
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "port_conflict",
        message: "m",
        detail: { reason: "foreign" },
      },
    });
  });

  it("uses default_workdir with ~ expanded, and does not touch Documents", async () => {
    const documentsDir = vi.fn(() => {
      throw new Error("no documents");
    });
    const { result } = await runBoot(
      deps({
        startConfig: () => ({
          defaultWorkdir: "rel/work",
          port: 6174,
          mirror: null,
        }),
        documentsDir,
      })
    );
    expect(result).toMatchObject({ ok: true, workspace: resolve("rel/work") });
    expect(documentsDir).not.toHaveBeenCalled();
  });
});

describe("first launch and repair", () => {
  it("asks about mirrors, installs, sets up and records the version, then starts", async () => {
    const recordSetup = vi.fn();
    const keepMirror = vi.fn();
    const runSetupFn = vi.fn(() => setupRun(0, []));
    const { d, runInstall, calls } = freshMachine({
      askMirror: async () => true,
      keepMirror,
      recordSetup,
      runSetup: runSetupFn,
    });
    const { result, states } = await runBoot(d);
    expect(result.ok).toBe(true);
    expect(states).toEqual([
      "checking_core",
      "asking_mirror",
      "installing",
      "installing",
      "checking_core",
      "setting_up",
      "setting_up",
      "starting_backend",
      "ready",
    ]);
    expect(keepMirror).toHaveBeenCalledWith(true);
    expect(runInstall).toHaveBeenCalledWith(true, expect.any(Function));
    // The manifest's stages without webui, with mirrors as answered.
    expect(runSetupFn).toHaveBeenCalledWith(
      "C:\\bin\\EvoSci.exe",
      true,
      [
        { id: "node", title: "Node.js", state: "pending" },
        {
          id: "research-env",
          title: "Python research environment",
          state: "pending",
        },
      ],
      expect.any(Function)
    );
    expect(recordSetup).toHaveBeenCalledWith("0.3.8");
    // Setup covers the node stage.
    expect(calls.some((a) => a.includes("--stage"))).toBe(false);
  });

  it("asks nothing when config.yaml or the kept answer decides, config.yaml first", async () => {
    const askMirror = vi.fn(async () => true);
    const a = freshMachine({
      askMirror,
      keptMirror: () => true,
      startConfig: () => ({
        defaultWorkdir: null,
        port: 6174,
        mirror: "default",
      }),
    });
    await runBoot(a.d);
    expect(a.runInstall).toHaveBeenCalledWith(false, expect.any(Function));
    const b = freshMachine({ askMirror, keptMirror: () => false });
    await runBoot(b.d);
    expect(b.runInstall).toHaveBeenCalledWith(false, expect.any(Function));
    const c = freshMachine({
      askMirror,
      startConfig: () => ({ defaultWorkdir: null, port: 6174, mirror: "cn" }),
    });
    await runBoot(c.d);
    expect(c.runInstall).toHaveBeenCalledWith(true, expect.any(Function));
    expect(askMirror).not.toHaveBeenCalled();
  });

  it("repairs a core that does not run: config.yaml copied first, no question", async () => {
    const order: string[] = [];
    let repaired = false;
    const askMirror = vi.fn(async () => true);
    const { result, states } = await runBoot(
      deps({
        askMirror,
        runCollect: async (_f, args) =>
          args[0] === "--version"
            ? repaired
              ? ok([versionLine()])
              : ok(["Traceback ..."], 1)
            : ok(['{"protocol":1,"stage":"node","status":"done"}']),
        backupConfig: () => (order.push("backup"), "/c/config.yaml.bak-1"),
        runInstall: (cn) => {
          order.push(`install cn=${cn}`);
          repaired = true;
          return installRun(0, []);
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(["backup", "install cn=false"]);
    expect(askMirror).not.toHaveBeenCalled();
    expect(states.slice(0, 3)).toEqual([
      "checking_core",
      "installing",
      "checking_core",
    ]);
  });

  it("a repair does not start when config.yaml cannot be copied", async () => {
    const runInstall = vi.fn(() => installRun(0, []));
    const { result } = await runBoot(
      deps({
        runCollect: async () => ok([], 1),
        backupConfig: () => {
          throw new Error("EACCES");
        },
        runInstall,
      })
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "install_failed" },
    });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("is install_failed with the output from the last Error: line", async () => {
    const lines = [
      "Downloading uv 0.12.23...",
      "Error: EvoScientist is running, and the install cannot replace it while it runs:",
      "  python (PID 2296): C:\\Users\\Zoë\\python.exe",
      "Close these windows (a background server: EvoSci server stop), then run this script again. Nothing was changed.",
    ];
    const { d } = freshMachine({ runInstall: () => installRun(1, lines) });
    const { result } = await runBoot(d);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "install_failed",
        detail: {
          output: lines.slice(1),
          running: true,
          cn: false,
          repair: false,
        },
      },
    });
  });

  it("is install_failed when EvoSci is still missing or broken after the install", async () => {
    const a = await runBoot(deps({ locate: async () => null }));
    expect(a.result).toMatchObject({
      ok: false,
      error: { code: "install_failed" },
    });
    let installed = false;
    const b = await runBoot(
      deps({
        runCollect: async () => ok([], 1),
        runInstall: () => ((installed = true), installRun(0, [])),
      })
    );
    expect(installed).toBe(true);
    expect(b.result).toMatchObject({
      ok: false,
      error: {
        code: "install_failed",
        message: expect.stringContaining("still does not run"),
      },
    });
  });

  it("keeps repair, mirrors and the script's last lines when EvoSci is missing or broken after exit 0", async () => {
    const missing = freshMachine({
      locate: async () => null,
      startConfig: () => ({ defaultWorkdir: null, port: 6174, mirror: "cn" }),
      runInstall: () => installRun(0, ["Installed 3 executables", "Done."]),
    });
    expect((await runBoot(missing.d)).result).toMatchObject({
      error: {
        code: "install_failed",
        detail: {
          repair: false,
          cn: true,
          output: ["Installed 3 executables", "Done."],
        },
      },
    });
    const broken = await runBoot(
      deps({
        runCollect: async () => ok([], 1),
        runInstall: () => installRun(0, ["Done."]),
      })
    );
    expect(broken.result).toMatchObject({
      error: {
        code: "install_failed",
        detail: { repair: true, cn: false, output: ["Done."] },
      },
    });
  });

  it("refuses Windows on arm64 before running anything, and before the mirror question", async () => {
    const askMirror = vi.fn(async () => false);
    const keepMirror = vi.fn();
    const { d, runInstall } = freshMachine({
      windowsArm64: async () => true,
      askMirror,
      keepMirror,
    });
    const { result } = await runBoot(d);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_platform" },
    });
    expect(runInstall).not.toHaveBeenCalled();
    expect(askMirror).not.toHaveBeenCalled();
    expect(keepMirror).not.toHaveBeenCalled();
    const linux = freshMachine({
      platform: "linux",
      windowsArm64: async () => true,
    });
    expect((await runBoot(linux.d)).result.ok).toBe(true);
  });

  it("waits while an update holds its lock, then installs", async () => {
    let held = 2;
    const pause = vi.fn(async () => {});
    const { d, runInstall } = freshMachine({
      updateLockHeld: () => held-- > 0,
      pause,
    });
    const { states } = await runBoot(d);
    expect(states.filter((s) => s === "update_finishing")).toHaveLength(2);
    expect(pause).toHaveBeenCalledWith(3000);
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(states.indexOf("installing")).toBeGreaterThan(
      states.lastIndexOf("update_finishing")
    );
  });

  it("waits for the update lock before checking the core, so a core the update just finished is not reinstalled", async () => {
    let held = 2;
    const backupConfig = vi.fn(() => null);
    const runInstall = vi.fn(() => installRun(0, []));
    const { result, states } = await runBoot(
      deps({
        updateLockHeld: () => held-- > 0,
        runCollect: async (_f, args) =>
          args[0] === "--version"
            ? held > 0
              ? ok(["Traceback ..."], 1)
              : ok([versionLine()])
            : ok(['{"protocol":1,"stage":"node","status":"done"}']),
        backupConfig,
        runInstall,
      })
    );
    expect(result.ok).toBe(true);
    expect(backupConfig).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(states.slice(0, 3)).toEqual([
      "update_finishing",
      "update_finishing",
      "checking_core",
    ]);
  });

  it("an update that takes its lock before the script runs: waits, looks again, and installs nothing over it", async () => {
    let kept: boolean | null = null;
    let coreThere = false;
    const lock = [false, true, true, false];
    const askMirror = vi.fn(async () => false);
    const runInstall = vi.fn(() => installRun(0, []));
    const { result, states } = await runBoot(
      deps({
        locate: async () => (coreThere ? "C:\\bin\\EvoSci.exe" : null),
        keptMirror: () => kept,
        keepMirror: (cn) => void (kept = cn),
        askMirror,
        updateLockHeld: () => lock.shift() ?? false,
        pause: async () => void (coreThere = true),
        runInstall,
      })
    );
    expect(result.ok).toBe(true);
    expect(runInstall).not.toHaveBeenCalled();
    expect(askMirror).toHaveBeenCalledTimes(1);
    expect(states.slice(0, 4)).toEqual([
      "checking_core",
      "asking_mirror",
      "update_finishing",
      "checking_core",
    ]);
  });

  it("starts nothing new once a quit has begun", async () => {
    let quitting = false;
    const startDeploy = vi.fn();
    const { d } = freshMachine({
      runInstall: () => {
        quitting = true;
        return installRun(1, []);
      },
      stopping: () => quitting,
      startDeploy,
    });
    const { result } = await runBoot(d);
    expect(result).toMatchObject({ ok: false, error: { code: "quitting" } });
    expect(startDeploy).not.toHaveBeenCalled();
  });

  it("does not start setup when a quit began during setup --manifest", async () => {
    let quitting = false;
    const runSetupFn = vi.fn(() => setupRun(0, []));
    const { d } = freshMachine({
      runCollect: async (_f, args) => {
        if (args[0] === "--version") return ok([versionLine()]);
        if (args[1] === "--manifest") {
          quitting = true;
          return ok([MANIFEST]);
        }
        return ok([]);
      },
      stopping: () => quitting,
      runSetup: runSetupFn,
    });
    const { result } = await runBoot(d);
    expect(result).toMatchObject({ ok: false, error: { code: "quitting" } });
    expect(runSetupFn).not.toHaveBeenCalled();
  });

  it("is setup_failed with the failed stages; nothing is recorded", async () => {
    const recordSetup = vi.fn();
    const stages: Stage[] = [
      {
        id: "node",
        title: "Node.js",
        state: "error",
        code: "download_failed",
        message: "blocked",
      },
      {
        id: "research-env",
        title: "Python research environment",
        state: "done",
      },
    ];
    const { d } = freshMachine({
      runSetup: () => setupRun(1, stages),
      recordSetup,
    });
    const { result } = await runBoot(d);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "setup_failed",
        message: "One setup step failed.",
        detail: {
          failed: [
            {
              id: "node",
              title: "Node.js",
              code: "download_failed",
              message: "blocked",
            },
          ],
        },
      },
    });
    expect(recordSetup).not.toHaveBeenCalled();
  });

  it("Continue skips setup and runs the node stage, but a fresh install still sets up", async () => {
    const runSetupFn = vi.fn(() => setupRun(0, []));
    const { d, calls } = freshMachine({
      locate: async () => "C:\\bin\\EvoSci.exe",
      runSetup: runSetupFn,
    });
    const result = await boot(d, () => {}, { skipSetup: true });
    expect(result.ok).toBe(true);
    expect(runSetupFn).not.toHaveBeenCalled();
    expect(calls).toContainEqual(["setup", "--stage", "node", "--json"]);
    const fresh = freshMachine({ runSetup: runSetupFn });
    await boot(fresh.d, () => {}, { skipSetup: true });
    expect(runSetupFn).toHaveBeenCalledTimes(1);
  });

  it("Retry with mirrors uses them for the install script and setup", async () => {
    const runSetupFn = vi.fn(
      (_e: string, _cn: boolean, _s: Stage[], _u: (s: Stage[]) => void) =>
        setupRun(0, [])
    );
    const { d, runInstall } = freshMachine({
      keptMirror: () => false,
      runSetup: runSetupFn,
    });
    await boot(d, () => {}, { cn: true });
    expect(runInstall).toHaveBeenCalledWith(true, expect.any(Function));
    expect(runSetupFn.mock.calls[0][1]).toBe(true);
  });

  it("runs setup after a fresh install even when the record names this version", async () => {
    const runSetupFn = vi.fn(() => setupRun(0, []));
    const { d } = freshMachine({
      setupRecord: () => "0.3.8",
      runSetup: runSetupFn,
    });
    expect((await runBoot(d)).result.ok).toBe(true);
    expect(runSetupFn).toHaveBeenCalledTimes(1);
  });

  it("a repair of a set-up version runs the node stage, not setup", async () => {
    const runSetupFn = vi.fn(() => setupRun(0, []));
    let repaired = false;
    const { result, states } = await runBoot(
      deps({
        runCollect: async (_f, args) =>
          args[0] === "--version" && !repaired
            ? ok([], 1)
            : args[0] === "--version"
            ? ok([versionLine()])
            : ok([]),
        runInstall: () => ((repaired = true), installRun(0, [])),
        runSetup: runSetupFn,
      })
    );
    expect(result.ok).toBe(true);
    expect(runSetupFn).not.toHaveBeenCalled();
    expect(states).toContain("preparing_node");
  });

  it("a fresh install forgets an old setup record, so a setup stopped or failed after it runs again", async () => {
    let record: string | null = "0.3.8";
    let manifests = 0;
    let quitting = false;
    let setupExit = 1;
    const runSetupFn = vi.fn(() => setupRun(setupExit, []));
    const { d } = freshMachine({
      setupRecord: () => record,
      recordSetup: (v) => void (record = v),
      runSetup: runSetupFn,
      stopping: () => quitting,
      runCollect: async (_f, args) => {
        if (args[0] === "--version") return ok([versionLine()]);
        if (args[1] === "--manifest") {
          quitting = ++manifests === 1;
          return ok([MANIFEST]);
        }
        return ok([]);
      },
    });
    expect((await runBoot(d)).result).toMatchObject({
      ok: false,
      error: { code: "quitting" },
    });
    expect(record).toBeNull();
    expect((await runBoot(d)).result).toMatchObject({
      ok: false,
      error: { code: "setup_failed" },
    });
    setupExit = 0;
    expect((await runBoot(d)).result.ok).toBe(true);
    expect(runSetupFn).toHaveBeenCalledTimes(2);
    expect(record).toBe("0.3.8");
  });

  it("a repair takes mirrors from config.yaml first, then the kept answer, and never asks", async () => {
    const cases = [
      { mirror: null, kept: true, cn: true },
      { mirror: "default", kept: true, cn: false },
      { mirror: "cn", kept: false, cn: true },
    ];
    for (const c of cases) {
      let repaired = false;
      const askMirror = vi.fn(async () => !c.cn);
      const runInstall = vi.fn((_cn: boolean, _onLine: (l: string) => void) => {
        repaired = true;
        return installRun(0, []);
      });
      await runBoot(
        deps({
          askMirror,
          keptMirror: () => c.kept,
          startConfig: () => ({
            defaultWorkdir: null,
            port: 6174,
            mirror: c.mirror,
          }),
          runCollect: async (_f, args) =>
            args[0] === "--version"
              ? repaired
                ? ok([versionLine()])
                : ok([], 1)
              : ok([]),
          runInstall,
        })
      );
      expect(runInstall).toHaveBeenCalledWith(c.cn, expect.any(Function));
      expect(askMirror).not.toHaveBeenCalled();
    }
  });

  it("runs setup when the core version changed since the last one", async () => {
    const runSetupFn = vi.fn(() => setupRun(0, []));
    const { result } = await runBoot(
      deps({ setupRecord: () => "0.3.7", runSetup: runSetupFn })
    );
    expect(result.ok).toBe(true);
    expect(runSetupFn).toHaveBeenCalledTimes(1);
  });
});

describe("mirrorChoice", () => {
  it("takes config.yaml first, then the kept answer", () => {
    expect(mirrorChoice({ mirror: "cn" }, false)).toBe(true);
    expect(mirrorChoice({ mirror: "default" }, true)).toBe(false);
    expect(mirrorChoice({ mirror: null }, true)).toBe(true);
    expect(mirrorChoice({ mirror: null }, null)).toBeNull();
  });
});

describe("checkCore", () => {
  const info = (version: string, protocol = 1, webuiCompat = ">=0.3,<0.5") => ({
    version,
    protocol,
    webuiCompat,
  });

  it.each([
    ["0.3.7", "core_too_old"],
    ["0.3.9rc1", "core_too_old"],
    ["0.4.0", "core_too_new"],
  ])("%s is %s", (version, code) => {
    expect(checkCore(info(version), manifest, "linux")?.code).toBe(code);
  });

  it("checks the protocol first and the WebUI range last", () => {
    expect(checkCore(info("0.4.0", 2), manifest, "linux")?.code).toBe(
      "unknown_protocol"
    );
    expect(
      checkCore(info("0.3.8", 1, ">=0.3,<0.4"), manifest, "linux")?.code
    ).toBe("webui_incompatible");
    expect(checkCore(info("0.3.8"), manifest, "linux")).toBeNull();
  });
});

describe("resolveWorkspace", () => {
  it("is workspace_unavailable when Documents cannot be resolved or the folder created", () => {
    const noDocs = resolveWorkspace(
      { defaultWorkdir: null, port: 1, mirror: null },
      {
        documentsDir: () => {
          throw new Error("Failed to get 'documents' path");
        },
        ensureDir: () => {},
      }
    );
    expect(noDocs).toMatchObject({
      ok: false,
      error: { code: "workspace_unavailable", detail: { source: "documents" } },
    });
    const cannotCreate = resolveWorkspace(
      { defaultWorkdir: "Z:\\missing", port: 1, mirror: null },
      {
        documentsDir: () => "/docs",
        ensureDir: () => {
          throw new Error("ENOENT");
        },
      }
    );
    expect(cannotCreate).toMatchObject({
      ok: false,
      error: {
        code: "workspace_unavailable",
        detail: { source: "default_workdir" },
      },
    });
  });
});

describe("core update (W03c)", () => {
  const UPDATE_MANIFEST =
    '{"protocol":1,"stages":[{"id":"node","title":"Node.js"},{"id":"research-env","title":"Python research environment"},{"id":"webui","title":"WebUI"}]}';

  /** A core at `from` until an update or the install script brings 0.3.8. */
  function oldCore(from: string, over: Partial<BootDeps> = {}) {
    const state = { version: from };
    const calls: string[][] = [];
    const runUpdate = vi.fn(
      (
        _f: string,
        _v: string,
        _s: Stage[],
        onUpdate: (v: UpdateView) => void
      ) => {
        onUpdate({ update: { progress: 0.3 }, stages: [], waiting: null });
        state.version = "0.3.8";
        return updateRun({ kind: "done", version: "0.3.8" });
      }
    );
    const runInstall = vi.fn(() => {
      state.version = "0.3.8";
      return installRun(0, ["Done."]);
    });
    let record: string | null = from;
    const recordSetup = vi.fn((v: string | null) => void (record = v));
    const runSetup = vi.fn(() => setupRun(0, []));
    const askUpdate = vi.fn(async () => {});
    const d = deps({
      runCollect: async (_f, args) => {
        calls.push(args);
        if (args[0] === "--version") return ok([versionLine(state.version)]);
        if (args[1] === "--manifest") return ok([UPDATE_MANIFEST]);
        return ok(['{"protocol":1,"stage":"node","status":"done"}']);
      },
      runUpdate,
      runInstall,
      recordSetup,
      runSetup,
      askUpdate,
      setupRecord: () => record,
      ...over,
    });
    return {
      d,
      state,
      calls,
      runUpdate,
      runInstall,
      recordSetup,
      runSetup,
      askUpdate,
    };
  }

  it("0.3.7: offer, lookup, update with the manifest's stages, record, node stage, ready", async () => {
    const lookupRelease = vi.fn(async () => ({
      ok: true as const,
      version: "0.3.8",
      url: INDEX,
    }));
    const c = oldCore("0.3.7", { lookupRelease });
    const { result, states } = await runBoot(c.d);
    expect(result).toMatchObject({ ok: true, core: { version: "0.3.8" } });
    expect(c.askUpdate).toHaveBeenCalledWith("0.3.7");
    expect(lookupRelease).toHaveBeenCalledWith(false);
    expect(c.runUpdate).toHaveBeenCalledWith(
      "C:\\bin\\EvoSci.exe",
      "0.3.8",
      [
        { id: "node", title: "Node.js", state: "pending" },
        {
          id: "research-env",
          title: "Python research environment",
          state: "pending",
        },
      ],
      expect.any(Function)
    );
    // The update ran setup: recorded, and only the node stage runs after it.
    expect(c.recordSetup).toHaveBeenCalledWith("0.3.8");
    expect(c.runSetup).not.toHaveBeenCalled();
    expect(c.runInstall).not.toHaveBeenCalled();
    expect(states).toEqual([
      "checking_core",
      "asking_update",
      "looking_up_release",
      "updating",
      "updating",
      "checking_core",
      "preparing_node",
      "starting_backend",
      "ready",
    ]);
  });

  it("asks again when the user keeps the app's backend running", async () => {
    const answers = [false, true];
    const stopOwnBackend = vi.fn(async () => answers.shift()!);
    const c = oldCore("0.3.7", { stopOwnBackend });
    const { result } = await runBoot(c.d);
    expect(result.ok).toBe(true);
    expect(c.askUpdate).toHaveBeenCalledTimes(2);
    expect(stopOwnBackend).toHaveBeenCalledTimes(2);
  });

  it("looks up on the Tsinghua mirror with mirror: cn in config.yaml only", async () => {
    const lookupRelease = vi.fn(async () => ({
      ok: true as const,
      version: "0.3.8",
      url: INDEX,
    }));
    await runBoot(
      oldCore("0.3.7", {
        lookupRelease,
        startConfig: () => ({ defaultWorkdir: null, port: 6174, mirror: "cn" }),
      }).d
    );
    // The kept answer does not reach `EvoSci update`.
    await runBoot(
      oldCore("0.3.7", { lookupRelease, keptMirror: () => true }).d
    );
    expect(lookupRelease.mock.calls).toEqual([[true], [false]]);
  });

  it("is release_lookup_failed when the lookup fails, and runs nothing", async () => {
    const c = oldCore("0.3.7", {
      lookupRelease: async () => ({
        ok: false,
        reason: "net::ERR_INTERNET_DISCONNECTED",
        url: INDEX,
      }),
    });
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "release_lookup_failed",
        detail: {
          url: INDEX,
          reason: "net::ERR_INTERNET_DISCONNECTED",
          cn: false,
        },
      },
    });
    expect(c.runUpdate).not.toHaveBeenCalled();
  });

  it("waits for an update that took its lock after the lookup, then checks again", async () => {
    const locks = [false, true, true, false];
    const c = oldCore("0.3.7");
    const runUpdate = vi.fn(c.runUpdate);
    const { result, states } = await runBoot({
      ...c.d,
      runUpdate,
      updateLockHeld: () => locks.shift() ?? false,
    });
    expect(states).toContain("update_finishing");
    // The second pass offered the update again and ran it once.
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it.each([
    [
      "no terminal line",
      { kind: "no_terminal_line", exit: { code: 0, signal: null } },
      "update_failed",
    ],
    [
      "environment_busy",
      {
        kind: "error",
        code: "environment_busy",
        message: "Update cancelled",
        detail: { waiting_for: [] },
      },
      "environment_busy",
    ],
    [
      "download_failed",
      { kind: "error", code: "download_failed", message: "m", detail: {} },
      "download_failed",
    ],
  ] as const)("%s ends in %s, nothing recorded", async (_n, outcome, code) => {
    const c = oldCore("0.3.7", {
      runUpdate: () => updateRun(outcome as UpdateOutcome),
    });
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({ ok: false, error: { code } });
    if (code !== "update_failed")
      expect(!result.ok && result.error.detail.update).toBe(true);
    expect(c.recordSetup).not.toHaveBeenCalled();
  });

  it("server_running: the app's own text, the port and the core's message", async () => {
    const c = oldCore("0.3.7", {
      runUpdate: () =>
        updateRun({
          kind: "error",
          code: "server_running",
          message: "kill $(lsof -ti :6174)",
          detail: {},
        }),
    });
    const { result } = await runBoot(c.d);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "server_running",
        message: "A backend started in a terminal is running.",
        detail: { port: 6174, core_message: "kill $(lsof -ti :6174)" },
      },
    });
  });

  it("setup_failed: the failed stages from the update, not recorded", async () => {
    const stages: Stage[] = [
      { id: "node", title: "Node.js", state: "done" },
      {
        id: "research-env",
        title: "Python research environment",
        state: "error",
        code: "install_failed",
        message: "no wheel",
      },
    ];
    const c = oldCore("0.3.7", {
      runUpdate: () =>
        updateRun(
          {
            kind: "error",
            code: "setup_failed",
            message: "m",
            detail: {},
          },
          { update: {}, stages, waiting: null }
        ),
    });
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "setup_failed",
        message: "One setup step failed after the update.",
        detail: {
          update: true,
          cn: false,
          failed: [
            {
              id: "research-env",
              title: "Python research environment",
              code: "install_failed",
              message: "no wheel",
            },
          ],
        },
      },
    });
    expect(c.recordSetup).not.toHaveBeenCalled();
  });

  it("after done, a core that does not run is update_failed; one that hangs is version_check_timeout", async () => {
    const broken = oldCore("0.3.7");
    let updated = false;
    const runCollect = async (_f: string, args: string[]) =>
      args[0] === "--version"
        ? updated
          ? ok([], 1)
          : ok([versionLine("0.3.7")])
        : ok([UPDATE_MANIFEST]);
    const { result } = await runBoot({
      ...broken.d,
      runCollect,
      runUpdate: () => {
        updated = true;
        return updateRun({ kind: "done", version: "0.3.8" });
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "update_failed" },
    });

    updated = false;
    const hangs = oldCore("0.3.7");
    const { result: r2 } = await runBoot({
      ...hangs.d,
      runCollect: async (f, args) =>
        updated && args[0] === "--version"
          ? { timedOut: true, code: null, stdout: [] }
          : runCollect(f, args),
      runUpdate: () => {
        updated = true;
        return updateRun({ kind: "done", version: "0.3.8" });
      },
    });
    expect(r2).toMatchObject({
      ok: false,
      error: { code: "version_check_timeout" },
    });
    expect(broken.recordSetup).not.toHaveBeenCalled();
  });

  it("records nothing when the updated core is still outside the range", async () => {
    // `done` while the core stays at 0.3.7: the version check after the
    // update is the guard, and the error is the plain range error.
    const c = oldCore("0.3.7", {
      runUpdate: () => updateRun({ kind: "done", version: "0.3.7" }),
    });
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "core_too_old" },
    });
    expect(c.recordSetup).not.toHaveBeenCalled();
    expect(c.askUpdate).toHaveBeenCalledTimes(1);
  });

  it("manual_update with a uv tool install, or when uv does not answer: the core's message only", async () => {
    for (const env of [true, null]) {
      const askSeparateInstall = vi.fn(async () => {});
      const c = oldCore("0.3.7", {
        uvToolEnvExists: async () => env,
        askSeparateInstall,
        runUpdate: () =>
          updateRun({
            kind: "error",
            code: "manual_update",
            message: "installed from a checkout",
            detail: {},
          }),
      });
      const { result } = await runBoot(c.d);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "manual_update", message: "installed from a checkout" },
      });
      expect(askSeparateInstall).not.toHaveBeenCalled();
      expect(c.runInstall).not.toHaveBeenCalled();
    }
  });

  it("manual_update without a uv tool install: separate copy with config.yaml backup, setup, then the notice", async () => {
    const askSeparateInstall = vi.fn(async () => {});
    const backupConfig = vi.fn(() => "/c/config.yaml.bak-x");
    const askMirror = vi.fn(async () => true);
    const c = oldCore("0.3.7", {
      uvToolEnvExists: async () => false,
      askSeparateInstall,
      backupConfig,
      askMirror,
      runUpdate: () =>
        updateRun({
          kind: "error",
          code: "manual_update",
          message: "pip or conda",
          detail: {},
        }),
    });
    const states: BootState[] = [];
    const result = await boot(c.d, (s) => states.push(s));
    expect(askSeparateInstall).toHaveBeenCalledWith("pip or conda", "0.3.7");
    expect(backupConfig).toHaveBeenCalled();
    expect(askMirror).not.toHaveBeenCalled();
    expect(states).toContainEqual({
      phase: "installing",
      repair: true,
      update: true,
      lines: [],
    });
    // A new version: W03b's setup runs.
    expect(c.runSetup).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      core: { version: "0.3.8" },
      notice: expect.stringContaining("is still 0.3.7"),
    });
  });

  it("0.3.6: a terminal backend on the port stops it before anything runs", async () => {
    const backendAnswers = vi.fn(async () => true);
    const c = oldCore("0.3.6", {
      backendAnswers,
      startConfig: () => ({ defaultWorkdir: null, port: 6200, mirror: null }),
    });
    const { result } = await runBoot(c.d);
    expect(backendAnswers).toHaveBeenCalledWith(6200);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "server_running", detail: { port: 6200 } },
    });
    expect(c.runInstall).not.toHaveBeenCalled();
    expect(c.runUpdate).not.toHaveBeenCalled();
  });

  it("0.3.6: the bundled script as an update (backup, no question, no lookup), then setup", async () => {
    const lookupRelease = vi.fn();
    const backupConfig = vi.fn(() => null);
    const c = oldCore("0.3.6", { lookupRelease, backupConfig });
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({ ok: true, core: { version: "0.3.8" } });
    expect(c.runInstall).toHaveBeenCalled();
    expect(backupConfig).toHaveBeenCalled();
    expect(lookupRelease).not.toHaveBeenCalled();
    expect(c.runUpdate).not.toHaveBeenCalled();
    expect(c.runSetup).toHaveBeenCalled();
    expect(!result.ok || result.notice).toBeUndefined();
  });

  it("a failed script for 0.3.6 says the update failed", async () => {
    const c = oldCore("0.3.6", {
      runInstall: () => installRun(1, ["Error: no network"]),
    });
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "install_failed",
        message: "EvoScientist could not be updated.",
        detail: { repair: true, update: true },
      },
    });
  });

  it("offers no update for a version that is not a release", async () => {
    const c = oldCore("0.3.8rc1");
    const { result } = await runBoot(c.d);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "core_too_old", detail: { not_a_release: true } },
    });
    expect(c.askUpdate).not.toHaveBeenCalled();
  });

  it("runs the update with no stage rows when the manifest gives none, and not at all after a quit during the lookup", async () => {
    const c = oldCore("0.3.7");
    const { result } = await runBoot({
      ...c.d,
      runCollect: async (f, args) =>
        args[1] === "--manifest"
          ? ok(["not json"], 2)
          : c.d.runCollect(f, args, "", 0),
    });
    expect(result.ok).toBe(true);
    expect(c.runUpdate.mock.calls[0][2]).toEqual([]);

    let quitting = false;
    const q = oldCore("0.3.7", {
      lookupRelease: async () => {
        quitting = true;
        return { ok: true, version: "0.3.8", url: INDEX };
      },
      stopping: () => quitting,
    });
    expect((await runBoot(q.d)).result).toMatchObject({
      ok: false,
      error: { code: "quitting" },
    });
    expect(q.runUpdate).not.toHaveBeenCalled();
  });

  it("starts nothing once a quit began, before or after the update", async () => {
    let quitting = false;
    const early = oldCore("0.3.7", {
      askUpdate: async () => void (quitting = true),
      stopping: () => quitting,
    });
    expect((await runBoot(early.d)).result).toMatchObject({
      ok: false,
      error: { code: "quitting" },
    });
    expect(early.runUpdate).not.toHaveBeenCalled();

    let done = false;
    const late = oldCore("0.3.7", { stopping: () => done });
    const { result } = await runBoot({
      ...late.d,
      runUpdate: () => {
        done = true;
        return updateRun({ kind: "done", version: "0.3.8" });
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "quitting" } });
    expect(late.recordSetup).not.toHaveBeenCalled();
  });
});
