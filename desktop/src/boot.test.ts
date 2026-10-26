import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  boot,
  checkCore,
  resolveWorkspace,
  type BootDeps,
  type BootState,
} from "./boot";
import type { DeployOutcome, DeploySession } from "./deploy";
import type { Collected } from "./proc";

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
    ...over,
  };
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

  it("is core_missing with the install command when EvoSci is not found or prints no version", async () => {
    const a = await runBoot(deps({ locate: async () => null }));
    expect(a.result).toMatchObject({
      ok: false,
      error: {
        code: "core_missing",
        detail: { install_command: expect.stringContaining("install.ps1") },
      },
    });
    const b = await runBoot(
      deps({ runCollect: async () => ok(["Traceback ..."], 1) })
    );
    expect(b.result).toMatchObject({
      ok: false,
      error: { code: "core_missing" },
    });
    expect(b.states).toEqual(["checking_core", "error"]);
  });

  it("is version_check_timeout, never core_missing, on a timeout", async () => {
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
