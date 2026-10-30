import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCoreConfig, resetCoreConfigCache } from "./coreConfig";
import { configDir } from "./paths";

let home: string;

function record(body: Record<string, unknown>) {
  const dir = join(home, ".config", "evoscientist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "langgraph_dev.workspace.json"),
    JSON.stringify({ workspace: "/w", config_dir: configDir(), ...body })
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "evo backend port ą-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "xdg"));
  delete process.env.EVOSCIENTIST_LANGGRAPH_DEV_PORT;
  resetCoreConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetCoreConfigCache();
  rmSync(home, { recursive: true, force: true });
});

describe("the backend's port", () => {
  it("is the one the running backend recorded", () => {
    record({ pid: process.pid, port: 16409 });

    expect(readCoreConfig().port).toBe(16409);
  });

  it("is the recorded one over config.yaml's", () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      join(configDir(), "config.yaml"),
      "langgraph_dev_port: 7000\n"
    );
    record({ pid: process.pid, port: 16409 });

    expect(readCoreConfig().port).toBe(16409);
  });

  it("is the environment's when it names one", () => {
    vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "6606");
    record({ pid: process.pid, port: 16409 });

    expect(readCoreConfig().port).toBe(6606);
  });

  it("is the configured one when the recording backend is gone", () => {
    record({ pid: 2 ** 22 + 7, port: 16409 });

    expect(readCoreConfig().port).toBe(6174);
  });

  it.each([0, 70000, 6174.5, "16409"])(
    "is the configured one when the recorded port is %s",
    (port) => {
      record({ pid: process.pid, port });

      expect(readCoreConfig().port).toBe(6174);
    }
  );

  // A string naming this very process would answer as alive if taken.
  it.each([0, -1, String(process.pid)])(
    "is the configured one when the recorded pid is %s",
    (pid) => {
      record({ pid, port: 16409 });

      expect(readCoreConfig().port).toBe(6174);
    }
  );

  it("is the configured one with a record from an older core", () => {
    record({ pid: process.pid });

    expect(readCoreConfig().port).toBe(6174);
  });

  it("is the configured one when the backend reads another configuration", () => {
    record({ pid: process.pid, port: 16409, config_dir: "/elsewhere" });

    expect(readCoreConfig().port).toBe(6174);
  });
});
