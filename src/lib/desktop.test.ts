// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopBridge, parseUpdateState } from "@/lib/desktop";
import {
  deferSetup,
  isSetupDeferred,
  resetSetupDeferral,
} from "@/lib/setupDeferral";

describe("desktopBridge", () => {
  afterEach(() => {
    delete window.evoscientistDesktop;
  });

  it("is null in a plain browser", () => {
    expect(desktopBridge()).toBeNull();
  });

  it("keeps only the members that have the right shape", async () => {
    const restartBackend = vi.fn(async () => ({ ok: true as const }));
    window.evoscientistDesktop = { restartBackend, defaultFolder: 42 };
    const bridge = desktopBridge();
    expect(bridge?.defaultFolder).toBeUndefined();
    await expect(bridge?.restartBackend?.()).resolves.toEqual({ ok: true });
    expect(restartBackend).toHaveBeenCalledOnce();
  });

  it("offers the app's default folder", () => {
    window.evoscientistDesktop = { defaultFolder: "C:\\Docs\\EvoScientist" };
    expect(desktopBridge()).toEqual({
      defaultFolder: "C:\\Docs\\EvoScientist",
    });
  });
  it("answers failed when the app throws or answers another shape", async () => {
    for (const restartBackend of [
      () => {
        throw new Error("ipc");
      },
      async () => undefined,
      async () => ({ ok: false }),
    ]) {
      window.evoscientistDesktop = { restartBackend };
      await expect(desktopBridge()?.restartBackend?.()).resolves.toEqual({
        ok: false,
        code: "failed",
      });
    }
  });
});

describe("setupDeferral", () => {
  afterEach(() => {
    resetSetupDeferral();
  });

  it("remembers Configure later per deployment", () => {
    expect(isSetupDeferred("http://127.0.0.1:6174")).toBe(false);
    deferSetup("http://127.0.0.1:6174/");
    expect(isSetupDeferred("http://127.0.0.1:6174")).toBe(true);
    expect(isSetupDeferred("http://127.0.0.1:6606")).toBe(false);
  });

  it("survives a reload of the tab", () => {
    deferSetup("http://127.0.0.1:6174");
    expect(window.sessionStorage.getItem("evoscientist-setup-later")).toBe(
      '["http://127.0.0.1:6174"]'
    );
  });

  it("still holds for this page load without storage", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    deferSetup("http://127.0.0.1:6174");
    expect(isSetupDeferred("http://127.0.0.1:6174")).toBe(true);
    spy.mockRestore();
  });
});

describe("desktopBridge appUpdate (W04)", () => {
  afterEach(() => {
    delete window.evoscientistDesktop;
  });

  const member = (over: Record<string, unknown> = {}) => ({
    state: vi.fn(async () => ({ kind: "ready", version: "0.4.3" })),
    onState: vi.fn(() => () => {}),
    download: vi.fn(async () => {}),
    restartToUpdate: vi.fn(async () => ({ ok: false, code: "busy" })),
    ...over,
  });

  it("is left out unless all four functions are there", () => {
    window.evoscientistDesktop = { appUpdate: member({ download: 1 }) };
    expect(desktopBridge()?.appUpdate).toBeUndefined();
    window.evoscientistDesktop = { appUpdate: "x" };
    expect(desktopBridge()?.appUpdate).toBeUndefined();
  });

  it("reads the states and drops other shapes", () => {
    expect(parseUpdateState({ kind: "ready", version: "0.4.3" })).toEqual({
      kind: "ready",
      version: "0.4.3",
    });
    expect(
      parseUpdateState({
        kind: "downloading",
        version: "0.4.3",
        percent: 140.6,
      })
    ).toEqual({ kind: "downloading", version: "0.4.3", percent: 100 });
    expect(
      parseUpdateState({ kind: "available", version: "0.4.3", failed: "yes" })
    ).toEqual({ kind: "available", version: "0.4.3", failed: false });
    for (const bad of [
      null,
      3,
      { kind: "ready" },
      { kind: "later", version: "1" },
    ])
      expect(parseUpdateState(bad)).toEqual({ kind: "none" });
  });

  it("wraps the app's answers: a throw or another shape never reaches the page", async () => {
    const a = member({
      state: async () => {
        throw new Error("ipc");
      },
      restartToUpdate: async () => {
        throw new Error("ipc");
      },
      download: async () => {
        throw new Error("ipc");
      },
      onState: () => 42,
    });
    window.evoscientistDesktop = { appUpdate: a };
    const u = desktopBridge()?.appUpdate;
    await expect(u?.state()).resolves.toEqual({ kind: "none" });
    await expect(u?.restartToUpdate()).resolves.toEqual({
      ok: false,
      code: "failed",
    });
    await expect(u?.download()).resolves.toBeUndefined();
    expect(() => u?.onState(() => {})()).not.toThrow();
  });

  it("passes changes through, parsed, and unsubscribes", async () => {
    const off = vi.fn();
    let send: (s: unknown) => void = () => {};
    window.evoscientistDesktop = {
      appUpdate: member({
        onState: (cb: (s: unknown) => void) => ((send = cb), off),
      }),
    };
    const seen: unknown[] = [];
    const unsubscribe = desktopBridge()!.appUpdate!.onState((s) =>
      seen.push(s)
    );
    send({ kind: "available", version: "0.4.3", failed: false });
    send({ nonsense: true });
    expect(seen).toEqual([
      { kind: "available", version: "0.4.3", failed: false },
      { kind: "none" },
    ]);
    unsubscribe();
    expect(off).toHaveBeenCalledOnce();
  });
});
