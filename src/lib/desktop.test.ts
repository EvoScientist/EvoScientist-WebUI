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
  it("offers the app's project folders, keeping only non-empty strings", () => {
    window.evoscientistDesktop = {
      projectFolders: { default: "C:/Docs/EvoScientist", launch: "D:/work" },
    };
    expect(desktopBridge()?.projectFolders).toEqual({
      default: "C:/Docs/EvoScientist",
      launch: "D:/work",
    });
    window.evoscientistDesktop = { projectFolders: { default: "", launch: 7 } };
    expect(desktopBridge()?.projectFolders).toEqual({});
    window.evoscientistDesktop = { projectFolders: "C:/Docs" };
    expect(desktopBridge()?.projectFolders).toBeUndefined();
  });

  it("passes the start folder to pickFolder and returns the chosen one", async () => {
    const pickFolder = vi.fn(async () => "D:\\work");
    window.evoscientistDesktop = { pickFolder };
    await expect(desktopBridge()?.pickFolder?.("D:\\old")).resolves.toBe(
      "D:\\work"
    );
    expect(pickFolder).toHaveBeenCalledWith("D:\\old");
    await desktopBridge()?.pickFolder?.();
    expect(pickFolder).toHaveBeenLastCalledWith(undefined);
  });

  it("reads a cancel, a throw or another shape from pickFolder as null", async () => {
    for (const pickFolder of [
      async () => null,
      () => {
        throw new Error("ipc");
      },
      async () => {
        throw new Error("ipc");
      },
      async () => "",
      async () => ({ path: "D:\\work" }),
    ]) {
      window.evoscientistDesktop = { pickFolder };
      await expect(desktopBridge()?.pickFolder?.()).resolves.toBeNull();
    }
    window.evoscientistDesktop = { pickFolder: "D:\\work" };
    expect(desktopBridge()?.pickFolder).toBeUndefined();
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

describe("desktopBridge().chatgpt", () => {
  afterEach(() => {
    delete window.evoscientistDesktop;
  });

  const members = () => ({
    signIn: vi.fn(async () => ({ ok: true, plan: "plus" })),
    cancelSignIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => ({ ok: true })),
  });

  it("offers chatgpt only with all three members", async () => {
    const all = members();
    window.evoscientistDesktop = { chatgpt: all };
    const chatgpt = desktopBridge()?.chatgpt;
    await expect(chatgpt?.signIn()).resolves.toEqual({
      ok: true,
      plan: "plus",
    });
    await expect(chatgpt?.signOut()).resolves.toEqual({ ok: true });
    await chatgpt?.cancelSignIn();
    expect(all.cancelSignIn).toHaveBeenCalledOnce();
    for (const missing of ["signIn", "cancelSignIn", "signOut"] as const) {
      const some: Record<string, unknown> = members();
      delete some[missing];
      window.evoscientistDesktop = { chatgpt: some };
      expect(desktopBridge()?.chatgpt).toBeUndefined();
    }
    window.evoscientistDesktop = { chatgpt: "yes" };
    expect(desktopBridge()?.chatgpt).toBeUndefined();
  });

  it("offers isSigningIn and waitForSignIn one by one, only as functions", () => {
    window.evoscientistDesktop = { chatgpt: members() };
    let chatgpt = desktopBridge()?.chatgpt;
    expect(chatgpt?.isSigningIn).toBeUndefined();
    expect(chatgpt?.waitForSignIn).toBeUndefined();
    window.evoscientistDesktop = {
      chatgpt: { ...members(), isSigningIn: async () => true },
    };
    chatgpt = desktopBridge()?.chatgpt;
    expect(chatgpt?.isSigningIn).toBeTypeOf("function");
    expect(chatgpt?.waitForSignIn).toBeUndefined();
    window.evoscientistDesktop = {
      chatgpt: { ...members(), waitForSignIn: async () => null },
    };
    chatgpt = desktopBridge()?.chatgpt;
    expect(chatgpt?.isSigningIn).toBeUndefined();
    expect(chatgpt?.waitForSignIn).toBeTypeOf("function");
    window.evoscientistDesktop = {
      chatgpt: { ...members(), isSigningIn: true, waitForSignIn: "no" },
    };
    chatgpt = desktopBridge()?.chatgpt;
    expect(chatgpt).toBeTruthy();
    expect(chatgpt?.isSigningIn).toBeUndefined();
    expect(chatgpt?.waitForSignIn).toBeUndefined();
  });

  it("reads isSigningIn as true only for true, and a throw as false", async () => {
    for (const [answer, expected] of [
      [true, true],
      [false, false],
      ["true", false],
      [1, false],
      [undefined, false],
    ] as const) {
      window.evoscientistDesktop = {
        chatgpt: { ...members(), isSigningIn: async () => answer },
      };
      await expect(desktopBridge()?.chatgpt?.isSigningIn?.()).resolves.toBe(
        expected
      );
    }
    window.evoscientistDesktop = {
      chatgpt: {
        ...members(),
        isSigningIn: () => {
          throw new Error("ipc");
        },
      },
    };
    await expect(desktopBridge()?.chatgpt?.isSigningIn?.()).resolves.toBe(
      false
    );
  });

  it("reads waitForSignIn as a sign-in's end, nothing as null, a throw as null", async () => {
    const wait = async (answer: () => unknown) => {
      window.evoscientistDesktop = {
        chatgpt: { ...members(), waitForSignIn: answer },
      };
      return desktopBridge()?.chatgpt?.waitForSignIn?.();
    };
    await expect(wait(async () => null)).resolves.toBeNull();
    await expect(wait(async () => undefined)).resolves.toBeNull();
    await expect(
      wait(() => {
        throw new Error("ipc");
      })
    ).resolves.toBeNull();
    await expect(
      wait(async () => ({ ok: true, plan: "pro" }))
    ).resolves.toEqual({ ok: true, plan: "pro" });
    await expect(wait(async () => ({ ok: true, plan: 3 }))).resolves.toEqual({
      ok: true,
      plan: null,
    });
    await expect(
      wait(async () => ({ ok: false, code: "timed_out", message: "late" }))
    ).resolves.toEqual({ ok: false, code: "timed_out", message: "late" });
    await expect(wait(async () => "yes")).resolves.toEqual({
      ok: false,
      code: "failed",
      message: "",
    });
  });

  it("reads a throw or another shape as failed", async () => {
    window.evoscientistDesktop = {
      chatgpt: {
        signIn: () => {
          throw new Error("ipc");
        },
        cancelSignIn: () => {
          throw new Error("ipc");
        },
        signOut: async () => undefined,
      },
    };
    const chatgpt = desktopBridge()?.chatgpt;
    const failed = { ok: false, code: "failed", message: "" };
    await expect(chatgpt?.signIn()).resolves.toEqual(failed);
    await expect(chatgpt?.signOut()).resolves.toEqual(failed);
    await expect(chatgpt?.cancelSignIn()).resolves.toBeUndefined();
  });

  it("keeps the app's code and message, and a plan only as text", async () => {
    window.evoscientistDesktop = {
      chatgpt: {
        ...members(),
        signIn: async () => ({ ok: true, plan: 3 }),
        signOut: async () => ({ ok: false, code: "cancelled" }),
      },
    };
    const chatgpt = desktopBridge()?.chatgpt;
    await expect(chatgpt?.signIn()).resolves.toEqual({ ok: true, plan: null });
    await expect(chatgpt?.signOut()).resolves.toEqual({
      ok: false,
      code: "cancelled",
      message: "",
    });
    window.evoscientistDesktop = {
      chatgpt: {
        ...members(),
        signIn: async () => ({
          ok: false,
          code: "port_in_use",
          message: "Port 1455 is in use.",
        }),
      },
    };
    await expect(desktopBridge()?.chatgpt?.signIn()).resolves.toEqual({
      ok: false,
      code: "port_in_use",
      message: "Port 1455 is in use.",
    });
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
