// electron-updater's own Windows updater against a loopback feed, through
// the app's update flow (appUpdate.ts) and its settings (`configureUpdater`):
// no update, an update, a SHA-512 mismatch, a cut download, a stalled
// download, a whole download where one of the changed blocks could run, and
// a feed without `latest.yml`.
// Node's HTTP client stands in for Electron's `net` under
// electron-updater's own executor, and the
// updater runs as on Windows (`_testOnlyOptions.platform`), as in
// electron-updater's own tests.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CancellationToken, NsisUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  configureUpdater,
  createAppUpdate,
  type UpdateState,
} from "./appUpdate";

const INSTALLER = randomBytes(256 * 1024);
const SHA512 = createHash("sha512").update(INSTALLER).digest("base64");

/** A blockmap of the installer in two halves, as electron-builder writes. */
const blockmap = (checksums: string[]) =>
  gzipSync(
    JSON.stringify({
      version: "2",
      files: [
        {
          name: "file",
          offset: 0,
          checksums,
          sizes: [INSTALLER.length / 2, INSTALLER.length / 2],
        },
      ],
    })
  );

function latestYml(version: string, sha512 = SHA512): string {
  return [
    `version: ${version}`,
    "files:",
    "  - url: EvoScientist-Setup.exe",
    `    sha512: ${sha512}`,
    `    size: ${INSTALLER.length}`,
    "path: EvoScientist-Setup.exe",
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-29T00:00:00.000Z'",
    "",
  ].join("\n");
}

/** electron-updater's own executor (its `download()` included), with Node's
 *  HTTP client in place of Electron's `net`. */
class LoopbackExecutor extends ElectronHttpExecutor {
  constructor() {
    super(() => {});
  }
  override createRequest(
    options: Record<string, unknown>,
    callback: (response: unknown) => void
  ) {
    return request(options, callback) as never;
  }
  protected override addRedirectHandlers(): void {}
}

let server: Server;
let base: string;
let dir: string;
/** `latest.yml` requests per feed. */
const asked: Record<string, number> = {};
/** Installer requests per feed: the range asked for, or "whole". */
const fetched: Record<string, string[]> = {};
/** The quit handlers electron-updater registered, per updater. */
const quitHandlers: Record<string, number> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "evo-update-feed-"));
  server = createServer((req, res) => {
    // The updater adds `?noCache=...`.
    const [, feed, file] = new URL(req.url ?? "/", base).pathname.split("/");
    if (file === "latest.yml") asked[feed] = (asked[feed] ?? 0) + 1;
    if (file === "latest.yml" && feed === "hang") return; // never answers
    if (file === "latest.yml") {
      const yml =
        feed === "same"
          ? latestYml("0.4.2")
          : feed === "bad"
          ? latestYml(
              "0.4.3",
              createHash("sha512").update("x").digest("base64")
            )
          : feed === "missing"
          ? null
          : latestYml("0.4.3");
      if (!yml) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/yaml" }).end(yml);
      return;
    }
    if (file === "EvoScientist-Setup.exe.blockmap" && feed === "blockstall") {
      res.writeHead(200).end(blockmap(["new-a", "new-b"]));
      return;
    }
    if (file !== "EvoScientist-Setup.exe") {
      res.writeHead(404).end();
      return;
    }
    (fetched[feed] ??= []).push(req.headers.range ?? "whole");
    if (feed === "blockstall" && req.headers.range) {
      // The changed blocks: some bytes, then nothing.
      res.writeHead(206, {
        "content-length": INSTALLER.length,
        "content-range": `bytes 0-${INSTALLER.length - 1}/${INSTALLER.length}`,
      });
      res.write(INSTALLER.subarray(0, 1024));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": INSTALLER.length,
    });
    if (feed === "cut") {
      // Half the bytes, then the connection closes.
      res.write(INSTALLER.subarray(0, INSTALLER.length / 2), () =>
        res.socket?.destroy()
      );
      return;
    }
    if (feed === "stall") {
      // Some bytes, then nothing; the connection stays open.
      res.write(INSTALLER.subarray(0, 1024));
      return;
    }
    res.end(INSTALLER);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function updaterFor(feed: string, name: string, blocks = false) {
  const home = join(dir, name);
  if (blocks) {
    // What the installer leaves for a download of the changed blocks: itself
    // and its blockmap in the updater's cache.
    const cache = join(home, `${name}-updater`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "installer.exe"), randomBytes(INSTALLER.length));
    writeFileSync(join(cache, "current.blockmap"), blockmap(["a", "b"]));
  }
  const appUpdateConfigPath = join(dir, `${name}-app-update.yml`);
  writeFileSync(
    appUpdateConfigPath,
    `provider: generic\nurl: ${base}/${feed}\nupdaterCacheDirName: ${name}-updater\n`
  );
  const updater = new NsisUpdater(null, {
    version: "0.4.2",
    name: "EvoScientist",
    isPackaged: true,
    appUpdateConfigPath,
    userDataPath: home,
    baseCachePath: home,
    whenReady: () => Promise.resolve(),
    relaunch: () => {},
    quit: () => {},
    onQuit: () => {
      quitHandlers[name] = (quitHandlers[name] ?? 0) + 1;
    },
  });
  const internals = updater as unknown as {
    httpExecutor: unknown;
    _testOnlyOptions: unknown;
  };
  internals.httpExecutor = new LoopbackExecutor();
  internals._testOnlyOptions = {
    platform: "win32",
    isUseDifferentialDownload: blocks,
  };
  // The provider takes the executor when the feed is set. GitHub's provider
  // asks for one range per request.
  updater.setFeedURL({
    provider: "generic",
    url: `${base}/${feed}`,
    useMultipleRangeRequest: false,
  });
  return configureUpdater(updater, { info: () => {}, warn: () => {} });
}

// electron-updater reports progress at most once a second, so a watchdog
// shorter than that cancels a download that is merely slow; only the stall
// test uses one.
function flow(
  feed: string,
  name: string,
  stallMs = 5_000,
  checkLimitMs = 5_000,
  blocks = false
) {
  const logs: string[] = [];
  const waiters: { pred: (s: UpdateState) => boolean; done: () => void }[] = [];
  const u = createAppUpdate({
    updater: updaterFor(feed, name, blocks),
    newToken: () => new CancellationToken(),
    online: () => true,
    log: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
    },
    onChange: (s) => {
      for (const w of waiters.splice(0)) {
        if (w.pred(s)) w.done();
        else waiters.push(w);
      }
    },
    stallMs,
    checkLimitMs,
  });
  const until = (pred: (s: UpdateState) => boolean) =>
    pred(u.state)
      ? Promise.resolve()
      : new Promise<void>((done) => waiters.push({ pred, done }));
  return { u, logs, until };
}

describe("electron-updater against a loopback feed", () => {
  it("has the private fields the app resets", () => {
    // forgetPendingCheck and forgetEarlierInstall (appUpdate.ts).
    const updater = updaterFor("same", "fields");
    expect("checkForUpdatesPromise" in updater).toBe(true);
    expect("quitAndInstallCalled" in updater).toBe(true);
  });

  it("finds no update when the feed has the running version", async () => {
    const t = flow("same", "same");
    await t.u.check();
    expect(t.u.state).toEqual({ kind: "none" });
    expect(t.logs).toContain("info update check: no update");
  });

  it("offers an update, downloads it on request and verifies it", async () => {
    const t = flow("ok", "ok");
    await t.u.check();
    expect(t.u.state).toEqual({
      kind: "available",
      version: "0.4.3",
      failed: false,
    });
    // The check downloads nothing.
    await new Promise((r) => setTimeout(r, 300));
    expect(fetched.ok).toBeUndefined();
    t.u.download();
    await t.until((s) => s.kind !== "downloading");
    expect(t.u.state).toEqual({ kind: "ready", version: "0.4.3" });
    // The installer electron-updater saved is the one Restart to update runs.
    expect(t.u.installable()).toBe(true);
    // Nothing installs it on quit.
    expect(quitHandlers.ok).toBeUndefined();
  });

  it("asks the feed again after a check that got no answer", async () => {
    // electron-updater hands a running check to every later call; the limit
    // must make the next check a new request.
    const t = flow("hang", "hang", 5_000, 200);
    const pause = () => new Promise((r) => setTimeout(r, 400));
    void t.u.check();
    await pause();
    void t.u.check();
    await pause();
    expect(t.logs.filter((l) => l.includes("no answer"))).toHaveLength(2);
    expect(asked.hang).toBe(2);
  });

  it("refuses a download whose SHA-512 does not match latest.yml", async () => {
    const t = flow("bad", "bad");
    await t.u.check();
    t.u.download();
    await t.until((s) => s.kind !== "downloading");
    expect(t.u.state).toMatchObject({ kind: "available", failed: true });
    expect(t.logs.join("\n")).toMatch(/update download failed: .*sha512/i);
  });

  it("does not take a cut connection as a finished download", async () => {
    const t = flow("cut", "cut");
    await t.u.check();
    t.u.download();
    await t.until((s) => s.kind !== "downloading");
    expect(t.u.state).toMatchObject({ kind: "available", failed: true });
    expect(t.logs.join("\n")).toMatch(/update download failed/);
  });

  it("cancels a download that stops receiving data", async () => {
    const t = flow("stall", "stall", 300);
    await t.u.check();
    t.u.download();
    await t.until((s) => s.kind !== "downloading");
    expect(t.u.state).toMatchObject({ kind: "available", failed: true });
    expect(t.logs).toContain(
      "warn update download: no data for 0 s, cancelled"
    );
  });

  it("downloads the whole installer even where it could download the changed blocks", async () => {
    // electron-updater's block download reads the cancel only when data
    // comes: a stalled one held every later Download, and when it ended it
    // emptied the download folder.
    const t = flow("blockstall", "blockstall", 300, 5_000, true);
    await t.u.check();
    t.u.download();
    await t.until((s) => s.kind !== "downloading");
    expect(t.u.state).toEqual({ kind: "ready", version: "0.4.3" });
    expect(fetched.blockstall).toEqual(["whole"]);
  });

  it("logs a feed without latest.yml as a failed check and offers nothing", async () => {
    const t = flow("missing", "missing");
    await t.u.check();
    expect(t.u.state).toEqual({ kind: "none" });
    expect(t.logs.join("\n")).toMatch(/update check failed: .*404/);
  });
});
