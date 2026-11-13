// electron-updater's updater for macOS, as the app's update relies on it
// (appUpdate.ts): what its `quitAndInstall` does to Electron's own updater.
// The real MacUpdater runs here against a stand-in for that updater, so a
// new electron-updater that works differently fails these.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MacUpdater } from "electron-updater/out/MacUpdater";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureUpdater, createAppUpdate } from "./appUpdate";

const load = createRequire(__filename);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Electron's own updater: an emitter with the two calls MacUpdater makes
 *  for an install. */
function fakeSystemUpdater() {
  return Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  });
}

/** The real MacUpdater, with `system` in place of Electron's updater. */
function macUpdater(system: ReturnType<typeof fakeSystemUpdater>) {
  // MacUpdater takes it from `require("electron")` when it is constructed:
  // that module is this stand-in here (outside Electron it is a path).
  const electron = load.resolve("electron");
  load.cache[electron] = {
    id: electron,
    filename: electron,
    loaded: true,
    exports: { autoUpdater: system },
  } as unknown as NodeJS.Module;
  const { MacUpdater: Real } = load("electron-updater/out/MacUpdater") as {
    MacUpdater: new (options: null, app: unknown) => MacUpdater;
  };
  const dir = mkdtempSync(join(tmpdir(), "evo-mac-updater-"));
  dirs.push(dir);
  const appUpdateConfigPath = join(dir, "app-update.yml");
  writeFileSync(
    appUpdateConfigPath,
    "provider: generic\nurl: http://127.0.0.1:9/\nupdaterCacheDirName: evoscientist-updater\n"
  );
  const quit = vi.fn();
  const updater = new Real(null, {
    version: "0.5.2",
    name: "EvoScientist",
    isPackaged: true,
    appUpdateConfigPath,
    userDataPath: dir,
    baseCachePath: dir,
    whenReady: () => Promise.resolve(),
    relaunch: () => {},
    quit,
    onQuit: () => {},
  });
  const lines: string[] = [];
  configureUpdater(updater, {
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
  });
  return { updater, quit, lines };
}

describe("MacUpdater.quitAndInstall, with the app's settings", () => {
  it("asks the system for the update and adds one listener that quits once the system has it", () => {
    const system = fakeSystemUpdater();
    const { updater } = macUpdater(system);
    const before = system.listenerCount("update-downloaded");
    updater.quitAndInstall();
    expect(system.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(system.listenerCount("update-downloaded")).toBe(before + 1);
    expect(system.quitAndInstall).not.toHaveBeenCalled();
    system.emit("update-downloaded");
    expect(system.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("adds a listener and asks again at every call, while the system has no update", () => {
    const system = fakeSystemUpdater();
    const { updater } = macUpdater(system);
    const before = system.listenerCount("update-downloaded");
    updater.quitAndInstall();
    updater.quitAndInstall();
    expect(system.listenerCount("update-downloaded")).toBe(before + 2);
    expect(system.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("installs at once, without a listener or a question, once the system holds the update", () => {
    const system = fakeSystemUpdater();
    const { updater } = macUpdater(system);
    system.emit("update-downloaded");
    const before = system.listenerCount("update-downloaded");
    updater.quitAndInstall();
    expect(system.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(system.checkForUpdates).not.toHaveBeenCalled();
    expect(system.listenerCount("update-downloaded")).toBe(before);
  });

  it("logs the system's error and keeps running", () => {
    const system = fakeSystemUpdater();
    const { updater, lines } = macUpdater(system);
    updater.quitAndInstall();
    expect(() =>
      system.emit("error", new Error("Code signature did not pass validation"))
    ).not.toThrow();
    expect(lines[0]).toBe(
      "warn updater: Error: Code signature did not pass validation"
    );
    expect(system.quitAndInstall).not.toHaveBeenCalled();
  });
});

// The same, through the app's update object: what `install`, a refusal and
// `abandonInstall` do to the real MacUpdater's listeners.
describe("the app's update on the real MacUpdater", () => {
  function ready() {
    const system = fakeSystemUpdater();
    const { updater, lines } = macUpdater(system);
    // A downloaded update, without the feed and the download.
    const real = updater as unknown as {
      checkForUpdates: unknown;
      downloadUpdate: unknown;
    };
    real.checkForUpdates = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "0.5.3" },
    });
    real.downloadUpdate = async () => ["/cache/pending/update.zip"];
    const u = createAppUpdate({
      updater,
      native: system,
      newToken: () => ({} as never),
      online: () => true,
      log: {
        info: (m) => lines.push(`info ${m}`),
        warn: (m) => lines.push(`warn ${m}`),
      },
      onChange: () => {},
      canOpen: () => true,
    });
    return { system, u, lines };
  }
  async function downloaded() {
    const t = ready();
    await t.u.check();
    t.u.download();
    await vi.waitFor(() => expect(t.u.state.kind).toBe("ready"));
    return t;
  }

  it("a refusal reaches the caller once, and abandoning leaves the system's updater as it was", async () => {
    const t = await downloaded();
    const before = t.system.listeners("update-downloaded");
    const onFailed = vi.fn();
    expect(t.u.install(onFailed)).toBe(true);
    expect(t.system.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(t.u.installPending()).toBe(true);
    t.system.emit("error", new Error("Code signature did not pass validation"));
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(t.u.installPending()).toBe(false);
    t.u.abandonInstall();
    expect(t.system.listeners("update-downloaded")).toEqual(before);
  });

  it("an answer after the install was abandoned does not quit; the next install does, at once", async () => {
    const t = await downloaded();
    expect(t.u.install()).toBe(true);
    t.u.abandonInstall(); // the wait ran out
    expect(t.u.installPending()).toBe(true);
    t.system.emit("update-downloaded"); // the system has it now
    expect(t.system.quitAndInstall).not.toHaveBeenCalled();
    expect(t.u.installPending()).toBe(false);
    expect(t.u.install()).toBe(true);
    expect(t.system.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(t.system.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(t.u.installPending()).toBe(false);
  });

  it("an install that goes through quits through the system's updater", async () => {
    const t = await downloaded();
    expect(t.u.install()).toBe(true);
    t.system.emit("update-downloaded");
    expect(t.system.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
