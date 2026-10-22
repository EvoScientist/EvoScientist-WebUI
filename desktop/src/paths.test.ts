import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandWorkdir,
  folderEnv,
  readStartConfig,
  resolveFolders,
  sharedDirFromEnv,
} from "./paths";

const HOME = resolve("/home/u");

describe("sharedDirFromEnv", () => {
  it.each([undefined, "", "  \t", "\x1c"])("treats %j as unset", (value) => {
    expect(sharedDirFromEnv("K", { K: value }, HOME)).toBeNull();
  });

  it("expands a leading ~ only", () => {
    expect(sharedDirFromEnv("K", { K: "~" }, HOME)).toBe(HOME);
    expect(sharedDirFromEnv("K", { K: "~/data" }, HOME)).toBe(
      join(HOME, "data")
    );
    expect(sharedDirFromEnv("K", { K: "~other/data" }, HOME)).toBe(
      resolve("~other/data")
    );
  });

  it("makes a relative path absolute", () => {
    expect(sharedDirFromEnv("K", { K: "rel" }, HOME)).toBe(resolve("rel"));
  });
});

describe("resolveFolders and folderEnv", () => {
  it("uses the defaults and drops XDG_CONFIG_HOME for children", () => {
    const f = resolveFolders({}, HOME);
    expect(f).toEqual({
      dataDir: join(HOME, ".evoscientist"),
      configDir: join(HOME, ".config", "evoscientist"),
      xdgConfigHomeSet: false,
    });
    const env = folderEnv({ PATH: "p", XDG_CONFIG_HOME: " " }, f);
    expect(env.EVOSCIENTIST_DATA_DIR).toBe(join(HOME, ".evoscientist"));
    expect("XDG_CONFIG_HOME" in env).toBe(false);
    expect(env.PATH).toBe("p");
  });

  it("passes both folders absolute when the app's environment sets them", () => {
    const f = resolveFolders(
      { EVOSCIENTIST_DATA_DIR: "~/d", XDG_CONFIG_HOME: "~/c" },
      HOME
    );
    expect(f.configDir).toBe(join(HOME, "c", "evoscientist"));
    expect(folderEnv({}, f)).toEqual({
      EVOSCIENTIST_DATA_DIR: join(HOME, "d"),
      XDG_CONFIG_HOME: join(HOME, "c"),
    });
  });
});

describe("readStartConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evosci-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("gives the defaults without a file", () => {
    expect(readStartConfig(dir, {})).toEqual({
      defaultWorkdir: null,
      port: 6174,
      mirror: null,
    });
  });

  it("reads the three keys and ignores the rest", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      "default_workdir: 'C:\\Users\\a\\work'\nlanggraph_dev_port: '6200'\nmirror: cn\nanthropic_api_key: secret\n"
    );
    expect(readStartConfig(dir, {})).toEqual({
      defaultWorkdir: "C:\\Users\\a\\work",
      port: 6200,
      mirror: "cn",
    });
  });

  it("lets the environment win for the folder and the port, ignoring a bad port", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      "default_workdir: /f\nlanggraph_dev_port: 6200\n"
    );
    expect(
      readStartConfig(dir, {
        EVOSCIENTIST_WORKSPACE_DIR: "/e",
        EVOSCIENTIST_LANGGRAPH_DEV_PORT: "6300",
      })
    ).toMatchObject({
      defaultWorkdir: "/e",
      port: 6300,
    });
    expect(
      readStartConfig(dir, {
        EVOSCIENTIST_LANGGRAPH_DEV_PORT: "abc",
        EVOSCIENTIST_WORKSPACE_DIR: "",
      })
    ).toMatchObject({
      defaultWorkdir: "/f",
      port: 6200,
    });
  });

  it.each(["key: [unclosed", "- a list\n- at the top", "port: 99999999"])(
    "counts %j as defaults",
    (text) => {
      writeFileSync(join(dir, "config.yaml"), text);
      expect(readStartConfig(dir, {})).toEqual({
        defaultWorkdir: null,
        port: 6174,
        mirror: null,
      });
    }
  );
});

describe("expandWorkdir", () => {
  it("expands ~ and makes the path absolute", () => {
    expect(expandWorkdir("~/w", HOME)).toBe(join(HOME, "w"));
    expect(expandWorkdir("w", HOME)).toBe(resolve("w"));
  });
});
