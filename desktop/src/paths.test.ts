import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureServerHome,
  expandWorkdir,
  folderEnv,
  folderKey,
  logFolder,
  readStartConfig,
  resolveFolders,
  runtimeDir,
  runtimeDirs,
  sharedDirFromEnv,
  withReadyFolders,
  writableFolder,
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
    // The log where the core the app installs keeps it: the server home of
    // the data folder.
    expect(r.ready).toEqual({
      url: "u",
      dataDir: folders.dataDir,
      configDir: folders.configDir,
      logFile: join(folders.dataDir, "server", "langgraph_dev.log"),
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

  // Where the core the app installs keeps it: a first session's own lines,
  // crash report and error screen are next to the backend's log.
  it("takes the server home when neither holds the backend's log", () => {
    expect(runtimeDir(dirs, () => false)).toBe(serverHome);
  });

  it("falls back to the server home only while the app installs a core that keeps its log there", () => {
    const installs = parseRelease(installVersion(evoscientist.coreRange) ?? "");
    expect(installs).not.toBeNull();
    expect(
      compareReleases(installs as number[], [0, 4, 2]),
      "the app now installs a core that keeps its log in ~/.config/evoscientist: revisit runtimeDir's fallback"
    ).toBeGreaterThanOrEqual(0);
  });
});

// Where the app's own logs open at its start, before `ready` names the
// backend's log.
describe("logFolder", () => {
  const dirs = runtimeDirs(join(HOME, ".evoscientist"), HOME);
  const [serverHome, older] = dirs;
  const logIn = (dir: string) => join(dir, "langgraph_dev.log");
  // A disk that holds `paths`; a folder among them can be written to unless
  // it is `locked`. `make` adds one.
  const disk = (paths: string[], locked: string[] = []) => {
    const there = new Set(paths);
    return {
      exists: (p: string) => there.has(p),
      writable: (p: string) => there.has(p) && !locked.includes(p),
      make: (p: string) => {
        there.add(p);
      },
    };
  };
  const never = () => {
    throw new Error("must not be called");
  };

  it("takes the folder that holds the backend's log and makes nothing", () => {
    expect(
      logFolder(dirs, disk([older, logIn(older)]), "darwin", never)
    ).toEqual({ dir: older, problem: null });
    const both = disk([serverHome, logIn(serverHome), older, logIn(older)]);
    expect(logFolder(dirs, both, "win32", never)).toEqual({
      dir: serverHome,
      problem: null,
    });
  });

  it("takes a server home the core has made, on every platform, and makes nothing", () => {
    for (const platform of ["darwin", "linux", "win32"] as const)
      expect(logFolder(dirs, disk([serverHome]), platform, never)).toEqual({
        dir: serverHome,
        problem: null,
      });
  });

  // `sudo EvoSci` can leave a server home that belongs to root.
  it("passes over a folder it cannot write to, and says why", () => {
    for (const platform of ["darwin", "win32"] as const)
      expect(
        logFolder(dirs, disk([serverHome], [serverHome]), platform, never)
      ).toEqual({ dir: older, problem: expect.stringMatching(/write/) });
    const both = disk(
      [serverHome, logIn(serverHome), older, logIn(older)],
      [serverHome]
    );
    expect(logFolder(dirs, both, "linux", never)).toEqual({
      dir: older,
      problem: null,
    });
  });

  it("makes the server home off Windows while there is none", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const d = disk([]);
      const made: string[] = [];
      const make = (p: string) => {
        made.push(p);
        d.make(p);
      };
      expect(logFolder(dirs, d, platform, make)).toEqual({
        dir: serverHome,
        problem: null,
      });
      expect(made).toEqual([serverHome]);
    }
  });

  // A link to a volume that is not mounted: the folder is not there, and
  // making it leaves the link as it is.
  it("passes over a server home it made but still cannot write to", () => {
    const keep = () => {};
    expect(logFolder(dirs, disk([]), "darwin", keep)).toEqual({
      dir: older,
      problem: expect.stringMatching(/write/),
    });
  });

  // A folder Node makes on Windows takes the access of the folder above it;
  // the core's Python makes one that only its owner can open.
  it("leaves the server home to the core on Windows", () => {
    expect(logFolder(dirs, disk([]), "win32", never)).toEqual({
      dir: older,
      problem: null,
    });
  });

  // A data folder on a drive that is gone or read-only: the app still logs.
  it("logs in the older folder, and says why, when the server home cannot be made", () => {
    const refuse = () => {
      throw new Error("EACCES: permission denied, mkdir '/x'");
    };
    expect(logFolder(dirs, disk([]), "linux", refuse)).toEqual({
      dir: older,
      problem: "EACCES: permission denied, mkdir '/x'",
    });
  });

  describe.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "on this disk",
    () => {
      let base: string;
      let data: string;
      beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "evo-logs-"));
        data = join(base, ".evoscientist");
        mkdirSync(data);
      });
      afterEach(() => {
        chmodSync(data, 0o755);
        const home = join(data, "server");
        if (existsSync(home)) chmodSync(home, 0o755);
        rmSync(base, { recursive: true, force: true });
      });
      const pick = () =>
        logFolder(
          runtimeDirs(data, base),
          { exists: existsSync, writable: writableFolder },
          process.platform,
          ensureServerHome
        );

      it("logs in the older folder when the data folder cannot be written", () => {
        chmodSync(data, 0o555);
        const r = pick();
        expect(r.dir).toBe(join(base, ".config", "evoscientist"));
        expect(r.problem).toMatch(/EACCES/);
      });

      it("logs in the older folder when the server home links to nothing", () => {
        symlinkSync(join(base, "unmounted"), join(data, "server"));
        const r = pick();
        expect(r.dir).toBe(join(base, ".config", "evoscientist"));
        expect(r.problem).toMatch(/write/);
      });

      it("logs in the older folder when the server home cannot be written", () => {
        const home = join(data, "server");
        mkdirSync(home);
        writeFileSync(join(home, "langgraph_dev.log"), "x");
        chmodSync(home, 0o500);
        const r = pick();
        expect(r.dir).toBe(join(base, ".config", "evoscientist"));
        expect(r.problem).toMatch(/write/);
      });
    }
  );
});

describe("writableFolder", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "evo-writable-"));
  });
  afterEach(() => {
    chmodSync(base, 0o755);
    rmSync(base, { recursive: true, force: true });
  });

  it("is true for a folder, and false for a file or for nothing", () => {
    expect(writableFolder(base)).toBe(true);
    // Executable, so only its kind tells it from a folder.
    writeFileSync(join(base, "file"), "x", { mode: 0o755 });
    expect(writableFolder(join(base, "file"))).toBe(false);
    expect(writableFolder(join(base, "none"))).toBe(false);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "is false for a folder this account cannot make files in",
    () => {
      chmodSync(base, 0o500);
      expect(writableFolder(base)).toBe(false);
    }
  );
});

// The app may need the server home before the core has made it (its own logs
// open there at start). The core makes it readable by its owner only, and
// narrows a wider one with a warning that the local secret was exposed.
describe("ensureServerHome", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "evo-home-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const mode = (p: string) => statSync(p).mode & 0o777;
  const posix = process.platform !== "win32";

  it.runIf(posix)(
    "makes it as the core does: readable by its owner only",
    () => {
      const data = join(base, ".evoscientist");
      const home = join(data, "server");
      ensureServerHome(home);
      expect(mode(home)).toBe(0o700);
      // The data folder above it is made as the core makes it, with the usual
      // mode: as a folder made beside it under the same umask.
      const plain = join(base, "plain");
      mkdirSync(plain);
      expect(mode(data)).toBe(mode(plain));
    }
  );

  it.runIf(posix)("leaves one that exists as it is", () => {
    const home = join(base, "server");
    mkdirSync(home);
    chmodSync(home, 0o755);
    writeFileSync(join(home, "langgraph_dev.log"), "x");
    ensureServerHome(home);
    expect(mode(home)).toBe(0o755);
    ensureServerHome(home);
    expect(mode(home)).toBe(0o755);
  });

  it("makes the folders on every platform", () => {
    const home = join(base, "a", "b", "server");
    ensureServerHome(home);
    expect(statSync(home).isDirectory()).toBe(true);
  });
});

describe("folderKey", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "evo-key-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const posix = (p: string) => p.replaceAll("\\", "/");

  it("follows a link to an existing folder", () => {
    mkdirSync(join(dir, "real"));
    // A junction needs no rights on Windows.
    symlinkSync(join(dir, "real"), join(dir, "link"), "junction");
    expect(folderKey(join(dir, "link"))).toBe(posix(join(dir, "real")));
  });

  it("resolves the existing parent of a missing folder", () => {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"), "junction");
    expect(folderKey(join(dir, "link", "gone", "deeper"))).toBe(
      posix(join(dir, "real", "gone", "deeper"))
    );
  });

  it("keeps a missing folder absolute, without a trailing slash", () => {
    expect(folderKey(join(dir, "gone") + "/")).toBe(posix(join(dir, "gone")));
    expect(folderKey(join(dir, "gone", "..", "x"))).toBe(posix(join(dir, "x")));
  });

  const missing = () => {
    throw new Error("ENOENT");
  };

  it("spells a Windows folder with forward slashes and keeps a root", () => {
    expect(folderKey("C:\\Users\\u\\Docs\\", win32, missing)).toBe(
      "C:/Users/u/Docs"
    );
    expect(folderKey("C:\\", win32, missing)).toBe("C:/");
    expect(folderKey("\\\\srv\\share\\proj", win32, missing)).toBe(
      "//srv/share/proj"
    );
  });

  it("takes the drive's spelling for a missing Windows folder", () => {
    const real = (p: string) => (p === "c:\\" ? "C:\\" : missing());
    expect(folderKey("c:\\gone\\x", win32, real)).toBe("C:/gone/x");
  });

  it("takes the real path's spelling on Windows", () => {
    const real = (p: string) =>
      p === "c:\\users\\u\\docs" ? "C:\\Users\\u\\Docs" : missing();
    expect(folderKey("c:\\users\\u\\docs", win32, real)).toBe(
      "C:/Users/u/Docs"
    );
  });

  it("keeps the root", () => {
    expect(folderKey("/", undefined, missing)).toBe(posix(resolve("/")));
  });

  it.skipIf(process.platform === "win32")(
    "keeps a backslash in a POSIX folder name",
    () => {
      expect(folderKey("/a\\b/", undefined, missing)).toBe("/a\\b");
    }
  );
});
