import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandWorkdir,
  folderEnv,
  readStartConfig,
  resolveFolders,
  runtimeDir,
  runtimeDirs,
  sharedDirFromEnv,
  withReadyFolders,
} from "./paths";
import { evoscientist } from "../package.json";
import { compareReleases, installVersion, parseRelease } from "./versions";

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
      // Unquoted, with brackets, as PyYAML (`EvoSci config set`) writes it.
      "default_workdir: C:\\Users\\a\\[lab] work\nlanggraph_dev_port: '6200'\nmirror: cn\nanthropic_api_key: secret\n"
    );
    expect(readStartConfig(dir, {})).toEqual({
      defaultWorkdir: "C:\\Users\\a\\[lab] work",
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

describe("withReadyFolders", () => {
  const folders = {
    dataDir: join(HOME, ".evoscientist"),
    configDir: join(HOME, ".config", "evoscientist"),
    xdgConfigHomeSet: false,
  };

  it("keeps the folders the core sent", () => {
    const ready = {
      url: "u",
      dataDir: "/d",
      configDir: "/c",
      logFile: "/l/x.log",
    };
    expect(withReadyFolders(ready, folders, () => false, HOME)).toEqual({
      ready,
      missing: [],
    });
  });

  it("fills in the app's own folders for missing fields and names them", () => {
    const r = withReadyFolders(
      { url: "u", dataDir: "", configDir: "", logFile: "" },
      folders,
      () => false,
      HOME
    );
    expect(r.ready).toEqual({
      url: "u",
      dataDir: folders.dataDir,
      configDir: folders.configDir,
      logFile: join(HOME, ".config", "evoscientist", "langgraph_dev.log"),
    });
    expect(r.missing).toEqual(["data_dir", "config_dir", "log_file"]);
  });

  it("fills in the log of the data folder ready names", () => {
    const r = withReadyFolders(
      { url: "u", dataDir: "/d", configDir: "/c", logFile: "" },
      folders,
      (p) => p === join("/d", "server", "langgraph_dev.log"),
      HOME
    );
    expect(r.ready.logFile).toBe(join("/d", "server", "langgraph_dev.log"));
  });
});

describe("runtimeDir", () => {
  const dirs = runtimeDirs(join(HOME, ".evoscientist"), HOME);
  const serverHome = join(HOME, ".evoscientist", "server");
  const older = join(HOME, ".config", "evoscientist");

  it("lists the server home before the older cores' folder", () => {
    expect(dirs).toEqual([serverHome, older]);
  });

  it("takes the server home when it holds the backend's log", () => {
    const has = (p: string) =>
      p === join(serverHome, "langgraph_dev.log") ||
      p === join(older, "langgraph_dev.log");
    expect(runtimeDir(dirs, has)).toBe(serverHome);
  });

  it("takes the older cores' folder when only it holds the backend's log", () => {
    const has = (p: string) => p === join(older, "langgraph_dev.log");
    expect(runtimeDir(dirs, has)).toBe(older);
  });

  it("takes the older cores' folder when neither holds the backend's log", () => {
    expect(runtimeDir(dirs, () => false)).toBe(older);
  });

  it("falls back to the older cores' folder only while the app installs a core that keeps its log there", () => {
    const installs = parseRelease(installVersion(evoscientist.coreRange) ?? "");
    expect(installs).not.toBeNull();
    expect(
      compareReleases(installs as number[], [0, 4, 2]),
      "the app now installs a core that keeps its log in the server home: revisit runtimeDir's fallback"
    ).toBeLessThan(0);
  });
});
