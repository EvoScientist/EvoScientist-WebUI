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
    ...over,
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

  it("Continue skips setup this time and runs the node stage", async () => {
    const runSetupFn = vi.fn(() => setupRun(0, []));
    const { d, calls } = freshMachine({ runSetup: runSetupFn });
    const result = await boot(d, () => {}, { skipSetup: true });
    expect(result.ok).toBe(true);
    expect(runSetupFn).not.toHaveBeenCalled();
    expect(calls).toContainEqual(["setup", "--stage", "node", "--json"]);
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
