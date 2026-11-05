import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_PORT,
  configPath,
  parseAllowedOrigins,
  readCoreConfig,
  resetCoreConfigCache,
} from "@/lib/server/coreConfig";

let xdg: string;
let home: string;

function writeConfig(text: string) {
  mkdirSync(join(xdg, "evoscientist"), { recursive: true });
  writeFileSync(join(xdg, "evoscientist", "config.yaml"), text);
}

/** A record of a running backend of this config folder and of `dataDir`
 *  (the default data folder unless given), in `dir`. */
function writeRecord(
  dir: string,
  port: number,
  dataDir = join(home, ".evoscientist")
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "langgraph_dev.workspace.json"),
    JSON.stringify({
      pid: process.pid,
      port,
      config_dir: join(xdg, "evoscientist"),
      data_dir: dataDir,
    })
  );
}

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "evo xdg ą-"));
  home = mkdtempSync(join(tmpdir(), "evo home-"));
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("EVOSCIENTIST_DATA_DIR", "");
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "");
  resetCoreConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(xdg, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("readCoreConfig", () => {
  it("finds config.yaml under $XDG_CONFIG_HOME/evoscientist", () => {
    expect(configPath()).toBe(join(xdg, "evoscientist", "config.yaml"));
    writeConfig("langgraph_dev_port: 7001\n");
    expect(readCoreConfig().port).toBe(7001);
  });

  it("prefers EVOSCIENTIST_LANGGRAPH_DEV_PORT over the file", () => {
    writeConfig("langgraph_dev_port: 7001\n");
    vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", " 7002 ");
    expect(readCoreConfig().port).toBe(7002);
  });

  it("falls back to the default with no file, a broken file or a bad port", () => {
    expect(readCoreConfig()).toEqual({
      port: DEFAULT_PORT,
      allowedOrigins: [],
    });
    resetCoreConfigCache();
    writeConfig("langgraph_dev_port: [7001\n");
    expect(readCoreConfig().port).toBe(DEFAULT_PORT);
    resetCoreConfigCache();
    writeConfig("langgraph_dev_port: 70000\n");
    expect(readCoreConfig().port).toBe(DEFAULT_PORT);
  });

  it("returns only the port and the trusted origins", () => {
    writeConfig(
      "openai_api_key: sk-secret\nlanggraph_dev_port: 7001\nbackend_allowed_origins: http://box.lan:4716\n"
    );
    expect(readCoreConfig()).toEqual({
      port: 7001,
      allowedOrigins: ["http://box.lan:4716"],
    });
  });

  it("caches for about a second", () => {
    writeConfig("langgraph_dev_port: 7001\n");
    expect(readCoreConfig(1000).port).toBe(7001);
    writeConfig("langgraph_dev_port: 7003\n");
    expect(readCoreConfig(1500).port).toBe(7001);
    expect(readCoreConfig(2100).port).toBe(7003);
  });
});

describe("readCoreConfig with a running backend's record", () => {
  const serverHome = () => join(home, ".evoscientist", "server");
  const oldRecordDir = () => join(home, ".config", "evoscientist");

  it("reads the port from the record in the server home", () => {
    writeConfig("langgraph_dev_port: 7001\n");
    writeRecord(serverHome(), 7010);
    expect(readCoreConfig().port).toBe(7010);
  });

  it("prefers the server home record over the old location", () => {
    writeRecord(serverHome(), 7010);
    writeRecord(oldRecordDir(), 7020);
    expect(readCoreConfig().port).toBe(7010);
  });

  it("falls back to the old location when the server home has no record", () => {
    writeRecord(oldRecordDir(), 7020);
    expect(readCoreConfig().port).toBe(7020);
  });

  it("falls back to the old location when the server home record is invalid", () => {
    writeRecord(serverHome(), 70000);
    writeRecord(oldRecordDir(), 7020);
    expect(readCoreConfig().port).toBe(7020);
  });

  it("ignores an old location record of another data folder", () => {
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", join(home, "a"));
    writeConfig("langgraph_dev_port: 7001\n");
    writeRecord(oldRecordDir(), 7020, join(home, "b"));
    expect(readCoreConfig().port).toBe(7001);
  });

  it("ignores a record without a data folder", () => {
    writeConfig("langgraph_dev_port: 7001\n");
    mkdirSync(oldRecordDir(), { recursive: true });
    writeFileSync(
      join(oldRecordDir(), "langgraph_dev.workspace.json"),
      JSON.stringify({
        pid: process.pid,
        port: 7020,
        config_dir: join(xdg, "evoscientist"),
      })
    );
    expect(readCoreConfig().port).toBe(7001);
  });

  it("matches the data folder through a symlink", () => {
    const real = join(home, "real");
    const link = join(home, "link");
    mkdirSync(real);
    symlinkSync(real, link, "junction");
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", link);
    writeRecord(oldRecordDir(), 7020, real);
    expect(readCoreConfig().port).toBe(7020);
  });

  it("finds the server home under EVOSCIENTIST_DATA_DIR", () => {
    const dataDir = join(home, "elsewhere");
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", dataDir);
    writeRecord(serverHome(), 7010);
    writeRecord(join(dataDir, "server"), 7030, dataDir);
    expect(readCoreConfig().port).toBe(7030);
  });
});

describe("parseAllowedOrigins", () => {
  it("reads a comma-separated string or a YAML list", () => {
    expect(
      parseAllowedOrigins(" http://box.lan:4716/ , https://evo.example.com")
    ).toEqual(["http://box.lan:4716", "https://evo.example.com"]);
    expect(parseAllowedOrigins(["http://a.lan", "http://[::1]:5150"])).toEqual([
      "http://a.lan",
      "http://[::1]:5150",
    ]);
  });

  it("leaves out entries the backend ignores", () => {
    expect(
      parseAllowedOrigins(
        "ftp://a.lan,http://b.lan/path,http://user@c.lan,http://d.lan?x=1,box.lan,,http://e.lan"
      )
    ).toEqual(["http://e.lan"]);
  });

  it("is empty for anything that is not a string or a list", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(42)).toEqual([]);
  });
});
