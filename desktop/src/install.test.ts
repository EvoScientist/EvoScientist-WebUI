import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backupConfig,
  backupName,
  failureOutput,
  installCommand,
  isWindowsArm64,
  parseRegArchitecture,
  refusedAsRunning,
  runInstallScript,
  updateLockHeld,
  updateLockPath,
} from "./install";

const quiet = { info: () => {}, warn: () => {} };
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "install-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const errno = (code: string) => Object.assign(new Error(code), { code });

describe("installCommand", () => {
  const env = {
    SystemRoot: "C:\\Windows",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    Path: "C:\\bin",
    EVOSCIENTIST_DATA_DIR: "C:\\Users\\Zoë Ł\\.evoscientist",
  };

  it("runs install.ps1 as a script block with UTF-8 output and no PSModulePath", () => {
    const c = installCommand({
      platform: "win32",
      scriptsDir: "C:\\app\\core-scripts",
      version: "0.3.8",
      cn: false,
      env,
    });
    expect(c.file).toMatch(/WindowsPowerShell.v1\.0.powershell\.exe$/);
    expect(c.args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(c.args[3]).toBe(
      "try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }; " +
        "$global:LASTEXITCODE = 1; " +
        "& ([scriptblock]::Create([IO.File]::ReadAllText($env:EVOSCI_INSTALL_SCRIPT))) " +
        "-Version 0.3.8 -NoSetup; exit $LASTEXITCODE"
    );
    expect(c.env.EVOSCI_INSTALL_SCRIPT).toMatch(/core-scripts.install\.ps1$/);
    expect(c.env.PSModulePath).toBeUndefined();
    expect(c.env.EVOSCIENTIST_DATA_DIR).toBe(env.EVOSCIENTIST_DATA_DIR);
    expect(c.args[3]).not.toMatch(/NoModifyPath|ExecutionPolicy/);
  });

  it("drops PSModulePath in any case and adds -Cn for mirrors", () => {
    const c = installCommand({
      platform: "win32",
      scriptsDir: "C:\\s",
      version: "0.3.8",
      cn: true,
      env: { PSMODULEPATH: "x", psmodulepath: "y" },
    });
    expect(Object.keys(c.env).map((k) => k.toUpperCase())).not.toContain(
      "PSMODULEPATH"
    );
    expect(c.args[3]).toContain(
      "-Version 0.3.8 -NoSetup -Cn; exit $LASTEXITCODE"
    );
  });

  it("runs install.sh with bash", () => {
    const c = installCommand({
      platform: "linux",
      scriptsDir: "/app/core-scripts",
      version: "0.3.8",
      cn: true,
      env: { HOME: "/home/u" },
    });
    expect(c).toEqual({
      file: "bash",
      args: [
        join("/app/core-scripts", "install.sh"),
        "--version",
        "0.3.8",
        "--no-setup",
        "--cn",
      ],
      env: { HOME: "/home/u" },
    });
  });
});

describe("Windows on arm64", () => {
  const out = [
    "",
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "    PROCESSOR_ARCHITECTURE    REG_SZ    ARM64",
    "",
  ];

  it("reads the value from reg query", () => {
    expect(parseRegArchitecture(out)).toBe("ARM64");
    expect(parseRegArchitecture(["nothing"])).toBeNull();
  });

  it("is true for ARM64, false for AMD64 or a failed reg", async () => {
    const reg = (stdout: string[], code = 0) =>
      vi.fn(async () => ({ timedOut: false, code, stdout }));
    expect(await isWindowsArm64(reg(out), quiet)).toBe(true);
    expect(
      await isWindowsArm64(reg([out[2].replace("ARM64", "AMD64")]), quiet)
    ).toBe(false);
    expect(await isWindowsArm64(reg([], 1), quiet)).toBe(false);
  });
});

describe("updateLockHeld", () => {
  it("is held only when opening the lock fails with EBUSY on Windows", () => {
    const close = vi.fn();
    const throws = (code: string) => () => {
      throw errno(code);
    };
    expect(updateLockHeld("/d", "win32", throws("EBUSY"), close)).toBe(true);
    expect(updateLockHeld("/d", "win32", throws("ENOENT"), close)).toBe(false);
    expect(updateLockHeld("/d", "win32", throws("EACCES"), close)).toBe(false);
    expect(updateLockHeld("/d", "win32", () => 7, close)).toBe(false);
    expect(close).toHaveBeenCalledWith(7);
    expect(updateLockHeld("/d", "linux", throws("EBUSY"), close)).toBe(false);
  });

  it("looks in the data folder's tools", () => {
    expect(updateLockPath("/data")).toBe(join("/data", "tools", "update.lock"));
  });
});

describe("backupConfig", () => {
  const when = new Date(2026, 9, 26, 9, 5, 7);

  it("names the copy with the local date and time", () => {
    expect(backupName(when)).toBe("config.yaml.bak-20261026-090507");
  });

  it("copies config.yaml and never over an existing backup", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.yaml"), "mirror: cn\n");
    const first = backupConfig(dir, when);
    writeFileSync(join(dir, "config.yaml"), "mirror: default\n");
    const second = backupConfig(dir, when);
    expect(first).toBe(join(dir, "config.yaml.bak-20261026-090507"));
    expect(second).toBe(join(dir, "config.yaml.bak-20261026-090507-2"));
    expect(readFileSync(first!, "utf8")).toBe("mirror: cn\n");
    expect(readFileSync(second!, "utf8")).toBe("mirror: default\n");
  });

  it("is null without a config.yaml, and throws when it cannot copy", () => {
    const dir = tempDir();
    expect(backupConfig(dir, when)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, "config.yaml"), "x");
    expect(() =>
      backupConfig(dir, when, () => {
        throw errno("EACCES");
      })
    ).toThrow("EACCES");
  });
});

describe("failure output", () => {
  const running = [
    "Downloading uv 0.12.23...",
    "Error: EvoScientist is running, and the install cannot replace it while it runs:",
    "  python (PID 2296): C:\\Users\\Public\\Evo ąę\\python.exe",
    "Close these windows (a background server: EvoSci server stop), then run this script again. Nothing was changed.",
  ];

  it("is the output from the last Error: line on", () => {
    expect(failureOutput(["Error: old", ...running])).toEqual(running.slice(1));
    expect(refusedAsRunning(failureOutput(running))).toBe(true);
    expect(refusedAsRunning(["Error: Cannot download ..."])).toBe(false);
  });

  it("is the last lines without an Error: line", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect(failureOutput(lines, 3)).toEqual(["line 27", "line 28", "line 29"]);
  });
});

describe.skipIf(process.platform === "win32")("runInstallScript", () => {
  it("reads both streams as UTF-8 lines and reports the exit code", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "install.sh"),
      'echo "Downloading uv..."; echo "Resolved 149 packages" >&2; echo "Error: C:\\\\Evo ąę failed" >&2; exit 1\n'
    );
    const shown: string[] = [];
    const cmd = installCommand({
      platform: "linux",
      scriptsDir: dir,
      version: "0.3.8",
      cn: false,
      env: process.env,
    });
    const r = runInstallScript(cmd, {
      cwd: dir,
      log: quiet,
      onLine: (l) => shown.push(l),
    });
    const { exit, lines } = await r.done;
    expect(exit.code).toBe(1);
    expect(lines).toEqual(shown);
    expect([...lines].sort()).toEqual(
      [
        "Downloading uv...",
        "Error: C:\\Evo ąę failed",
        "Resolved 149 packages",
      ].sort()
    );
    expect(cmd.args.slice(1)).toEqual(["--version", "0.3.8", "--no-setup"]);
  });

  it("cancel ends the script and what it started", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "install.sh"), "sleep 30 & echo $!; wait\n");
    let child = 0;
    const r = runInstallScript(
      installCommand({
        platform: "linux",
        scriptsDir: dir,
        version: "0.3.8",
        cn: false,
        env: process.env,
      }),
      { cwd: dir, log: quiet, onLine: (l) => (child = Number(l)) }
    );
    await vi.waitFor(() => expect(child).toBeGreaterThan(0));
    await r.cancel();
    await r.done;
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    await vi.waitFor(() => expect(alive()).toBe(false));
  });
});
