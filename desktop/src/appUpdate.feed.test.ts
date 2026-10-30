// electron-updater's own Windows updater against a loopback feed, through
// the app's update flow (appUpdate.ts): no update, an update, a SHA-512
// mismatch, a cut download, a stalled download and a feed without
// `latest.yml`. Node's HTTP client stands in for Electron's `net` under
// electron-updater's own executor, and the
// updater runs as on Windows (`_testOnlyOptions.platform`), as in
// electron-updater's own tests.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationToken, NsisUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppUpdate, type UpdateState } from "./appUpdate";

const INSTALLER = randomBytes(256 * 1024);
const SHA512 = createHash("sha512").update(INSTALLER).digest("base64");

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
    if (file !== "EvoScientist-Setup.exe") {
      res.writeHead(404).end();
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

function updaterFor(feed: string, name: string) {
  const home = join(dir, name);
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
    onQuit: () => {},
  });
  const internals = updater as unknown as {
    httpExecutor: unknown;
    _testOnlyOptions: unknown;
  };
  internals.httpExecutor = new LoopbackExecutor();
  internals._testOnlyOptions = {
    platform: "win32",
    isUseDifferentialDownload: false,
  };
  // The provider takes the executor when the feed is set.
  updater.setFeedURL({ provider: "generic", url: `${base}/${feed}` });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = null;
  return updater;
}

// electron-updater reports progress at most once a second, so a watchdog
// shorter than that cancels a download that is merely slow; only the stall
// test uses one.
function flow(
  feed: string,
  name: string,
  stallMs = 5_000,
  checkLimitMs = 5_000
) {
  const logs: string[] = [];
  const waiters: { pred: (s: UpdateState) => boolean; done: () => void }[] = [];
  const u = createAppUpdate({
    updater: updaterFor(feed, name),
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
    t.u.download();
    await t.until((s) => s.kind !== "downloading");
    expect(t.u.state).toEqual({ kind: "ready", version: "0.4.3" });
    // The installer electron-updater saved is the one Restart to update runs.
    expect(t.u.installable()).toBe(true);
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

  it("logs a feed without latest.yml as a failed check and offers nothing", async () => {
    const t = flow("missing", "missing");
    await t.u.check();
    expect(t.u.state).toEqual({ kind: "none" });
    expect(t.logs.join("\n")).toMatch(/update check failed: .*404/);
  });
});
