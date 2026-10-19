import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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

function writeConfig(text: string) {
  mkdirSync(join(xdg, "evoscientist"), { recursive: true });
  writeFileSync(join(xdg, "evoscientist", "config.yaml"), text);
}

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "evo xdg ą-"));
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "");
  resetCoreConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(xdg, { recursive: true, force: true });
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
