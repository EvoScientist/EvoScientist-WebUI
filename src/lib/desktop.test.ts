// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopBridge } from "@/lib/desktop";
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
