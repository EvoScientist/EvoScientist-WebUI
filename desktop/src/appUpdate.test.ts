import { CancellationToken } from "electron-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  CHECK_LIMIT_MS,
  FIRST_CHECK_MS,
  STALL_MS,
  createAppUpdate,
  type Updater,
  type UpdateState,
} from "./appUpdate";

type CheckResult = Awaited<ReturnType<Updater["checkForUpdates"]>>;

const INSTALLER = "C:\\cache\\pending\\EvoScientist-Setup.exe";

function fakeUpdater() {
  let progress: ((p: { percent: number }) => void) | null = null;
  const pending: {
    check?: { resolve(r: CheckResult): void; reject(e: Error): void };
    download?: { resolve(): void; reject(e: Error): void };
  } = {};
  const updater = {
    checkForUpdates: vi.fn(
      () =>
        new Promise<CheckResult>((resolve, reject) => {
          pending.check = { resolve, reject };
        })
    ),
    downloadUpdate: vi.fn(
      (_token: CancellationToken) =>
        new Promise<string[]>((resolve, reject) => {
          pending.download = { resolve: () => resolve([INSTALLER]), reject };
        })
    ),
    quitAndInstall: vi.fn(),
    on: vi.fn(
      (_e: "download-progress", fn: (p: { percent: number }) => void) => {
        progress = fn;
      }
    ),
  };
  return {
    updater,
    pending,
    progress: (percent: number) => progress?.({ percent }),
  };
}

const available = (version: string): CheckResult => ({
  isUpdateAvailable: true,
  updateInfo: { version },
});
const none: CheckResult = {
  isUpdateAvailable: false,
  updateInfo: { version: "0.4.2" },
};

function setup(
  opts: { online?: boolean; canOpen?: (p: string) => boolean } = {}
) {
  const f = fakeUpdater();
  const states: UpdateState[] = [];
  const logs: string[] = [];
  const tokens: CancellationToken[] = [];
  let online = opts.online ?? true;
  const u = createAppUpdate({
    updater: f.updater,
    newToken: () => {
      const t = new CancellationToken();
      tokens.push(t);
      return t;
    },
    online: () => online,
    log: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
    },
    onChange: (s) => states.push(s),
    canOpen: opts.canOpen ?? ((p) => p === INSTALLER),
  });
  return {
    ...f,
    u,
    states,
    logs,
    tokens,
    setOnline: (v: boolean) => (online = v),
  };
}

/** Lets the promise callbacks run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("checks", () => {
  it("checks 5 s after start, then every hour, and only once started", async () => {
    const t = setup();
    t.u.start();
    t.u.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(t.updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    t.pending.check?.resolve(none);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - FIRST_CHECK_MS);
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("offers an update without downloading it", async () => {
    const t = setup();
    const done = t.u.check();
    t.pending.check?.resolve(available("0.4.3"));
    await done;
    expect(t.u.state).toEqual({
      kind: "available",
      version: "0.4.3",
      failed: false,
    });
    expect(t.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("skips the check quietly while offline", async () => {
    const t = setup({ online: false });
    await t.u.check();
    expect(t.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(t.states).toEqual([]);
    expect(t.logs).toEqual(["info update check skipped: offline"]);
  });

  it("logs a failed check, keeps the offer and lets the next check run", async () => {
    const t = setup();
    let done = t.u.check();
    t.pending.check?.resolve(available("0.4.3"));
    await done;
    done = t.u.check();
    t.pending.check?.reject(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await done;
    expect(t.u.state.kind).toBe("available");
    expect(t.logs).toContain(
      "warn update check failed: net::ERR_NAME_NOT_RESOLVED"
    );
    done = t.u.check();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("fails a check without an answer after the limit and drops its late answer", async () => {
    const t = setup();
    // electron-updater's own record of the running check (the feed test
    // shows the real one): the limit forgets it.
    const inFlight = t.updater as unknown as {
      checkForUpdatesPromise: unknown;
    };
    inFlight.checkForUpdatesPromise = "pending";
    void t.u.check();
    const first = t.pending.check;
    await vi.advanceTimersByTimeAsync(CHECK_LIMIT_MS);
    expect(t.logs).toContain("warn update check: no answer in 60 s");
    expect(inFlight.checkForUpdatesPromise).toBeNull();
    // The next check runs although the first never answered.
    void t.u.check();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    first?.resolve(available("0.4.3"));
    await settle();
    expect(t.u.state.kind).toBe("none");
  });

  it("does not start a second check while one runs", async () => {
    const t = setup();
    void t.u.check();
    void t.u.check();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("withdraws an offer the feed no longer has, and moves it to a newer version", async () => {
    const t = setup();
    let done = t.u.check();
    t.pending.check?.resolve(available("0.4.3"));
    await done;
    done = t.u.check();
    t.pending.check?.resolve(available("0.4.4"));
    await done;
    expect(t.u.state).toMatchObject({ kind: "available", version: "0.4.4" });
    done = t.u.check();
    t.pending.check?.resolve(none);
    await done;
    expect(t.u.state).toEqual({ kind: "none" });
  });
});

describe("download", () => {
  async function offered() {
    const t = setup();
    const done = t.u.check();
    t.pending.check?.resolve(available("0.4.3"));
    await done;
    return t;
  }

  it("downloads only on request, shows progress and ends ready", async () => {
    const t = await offered();
    t.u.download();
    expect(t.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(t.u.state).toEqual({
      kind: "downloading",
      version: "0.4.3",
      percent: 0,
    });
    t.progress(42.7);
    expect(t.u.state).toMatchObject({ percent: 42 });
    t.pending.download?.resolve();
    await settle();
    expect(t.u.state).toEqual({ kind: "ready", version: "0.4.3" });
  });

  it("ignores Download without an offer or while one runs", async () => {
    const t = setup();
    t.u.download();
    expect(t.updater.downloadUpdate).not.toHaveBeenCalled();
    const o = await offered();
    o.u.download();
    o.u.download();
    expect(o.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps a download started while a re-check runs", async () => {
    const t = await offered();
    const recheck = t.u.check();
    t.u.download();
    t.pending.check?.resolve(none);
    await recheck;
    expect(t.u.state).toMatchObject({ kind: "downloading", version: "0.4.3" });
  });

  it("skips checks while downloading and once ready", async () => {
    const t = await offered();
    t.u.download();
    await t.u.check();
    t.pending.download?.resolve();
    await settle();
    await t.u.check();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("cancels a download that receives no data, and offers it again", async () => {
    const t = await offered();
    t.u.download();
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
    t.progress(10);
    // Data came: the watchdog starts over.
    await vi.advanceTimersByTimeAsync(STALL_MS - 1_000);
    expect(t.u.state.kind).toBe("downloading");
    expect(t.tokens[0].cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.tokens[0].cancelled).toBe(true);
    expect(t.u.state).toEqual({
      kind: "available",
      version: "0.4.3",
      failed: true,
    });
    expect(t.logs).toContain(
      "warn update download: no data for 60 s, cancelled"
    );
    // The cancelled download's late rejection changes nothing.
    t.pending.download?.reject(new Error("cancelled"));
    await settle();
    expect(t.u.state).toMatchObject({ kind: "available", failed: true });
    // The next check runs again.
    void t.u.check();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("offers a failed download again (a cut download fails the SHA-512 check)", async () => {
    const t = await offered();
    t.u.download();
    t.pending.download?.reject(new Error("sha512 checksum mismatch"));
    await settle();
    expect(t.u.state).toMatchObject({ kind: "available", failed: true });
    expect(t.logs).toContain(
      "warn update download failed: sha512 checksum mismatch"
    );
    t.u.download();
    expect(t.updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(t.u.state.kind).toBe("downloading");
  });
});

describe("install", () => {
  it("starts the installer only for a downloaded update, not silent, and runs the app after", async () => {
    const t = setup();
    expect(t.u.install()).toBe(false);
    const done = t.u.check();
    t.pending.check?.resolve(available("0.4.3"));
    await done;
    expect(t.u.install()).toBe(false);
    t.u.download();
    t.pending.download?.resolve();
    await settle();
    expect(t.u.install()).toBe(true);
    expect(t.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("offers the download again when the downloaded installer cannot be opened", async () => {
    let present = true;
    const t = setup({ canOpen: (p) => present && p === INSTALLER });
    const done = t.u.check();
    t.pending.check?.resolve(available("0.4.3"));
    await done;
    t.u.download();
    t.pending.download?.resolve();
    await settle();
    expect(t.u.installable()).toBe(true);
    present = false; // an antivirus removed it
    expect(t.u.installable()).toBe(false);
    expect(t.u.state).toEqual({
      kind: "available",
      version: "0.4.3",
      failed: true,
    });
    expect(t.u.install()).toBe(false);
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(t.logs.join("\n")).toMatch(
      /update install: the downloaded installer cannot be opened \(C:.*EvoScientist-Setup\.exe\); offering the download again/
    );
  });
});

describe("stop", () => {
  it("ends the scheduled checks", async () => {
    const t = setup();
    t.u.start();
    t.u.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(t.updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
