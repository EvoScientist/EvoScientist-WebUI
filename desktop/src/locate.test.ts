import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findUv, locateEvoSci, uvToolEnvExists } from "./locate";

describe("locateEvoSci", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evosci-locate-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const touch = (...parts: string[]) => {
    const p = join(root, ...parts);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "");
    return p;
  };

  it("prefers uv's tool bin directory, found with the recorded uv, over PATH", async () => {
    const uv = touch("data", "tools", "uv-0.12", "uv.exe");
    writeFileSync(
      join(root, "data", "tools", "uv.json"),
      JSON.stringify({ path: uv })
    );
    const inBin = touch("bin", "EvoSci.exe");
    touch("pathdir", "EvoSci.exe");
    const toolBinDir = vi.fn(async () => join(root, "bin"));
    const found = await locateEvoSci({
      dataDir: join(root, "data"),
      env: { PATH: join(root, "pathdir") },
      platform: "win32",
      toolBinDir,
    });
    expect(toolBinDir).toHaveBeenCalledWith(uv);
    expect(found).toEqual({ path: inBin, via: "uv-tool-bin" });
  });

  it("uses ~/.local/bin without any uv, then PATH", async () => {
    const local = touch("home", ".local", "bin", "evosci");
    const toolBinDir = vi.fn(async () => null);
    const inLocal = await locateEvoSci({
      dataDir: join(root, "data"),
      env: { PATH: "" },
      platform: "linux",
      home: join(root, "home"),
      toolBinDir,
    });
    // A case-insensitive file system (Windows) finds it as "EvoSci" first.
    expect(inLocal?.via).toBe("local-bin");
    expect(inLocal?.path.toLowerCase()).toBe(local.toLowerCase());
    expect(toolBinDir).not.toHaveBeenCalled();

    rmSync(local);
    const onPath = touch("p2", "EvoSci");
    expect(
      await locateEvoSci({
        dataDir: join(root, "data"),
        env: { PATH: ["", join(root, "p1"), join(root, "p2")].join(delimiter) },
        platform: "linux",
        home: join(root, "home"),
        toolBinDir,
      })
    ).toEqual({ path: onPath, via: "path" });
  });

  it("is null when nothing is installed", async () => {
    expect(
      await locateEvoSci({
        dataDir: root,
        env: {},
        platform: "win32",
        home: root,
        toolBinDir: async () => null,
      })
    ).toBeNull();
  });
});

describe("findUv", () => {
  it("ignores a recorded uv that no longer exists", () => {
    const root = mkdtempSync(join(tmpdir(), "evosci-uv-"));
    try {
      mkdirSync(join(root, "tools"));
      writeFileSync(
        join(root, "tools", "uv.json"),
        JSON.stringify({ path: join(root, "gone", "uv") })
      );
      expect(findUv(root, { PATH: "" }, "linux")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("uvToolEnvExists", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "evosci-toolenv-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const withUv = () => {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "uv"), "");
    return { PATH: join(root, "bin") };
  };

  it("is false without uv, and never asks it", async () => {
    const toolDir = vi.fn(async () => root);
    expect(
      await uvToolEnvExists({
        dataDir: join(root, "data"),
        env: { PATH: join(root, "nothing") },
        platform: "linux",
        toolDir,
      })
    ).toBe(false);
    expect(toolDir).not.toHaveBeenCalled();
  });

  it("looks for <uv tool dir>/evoscientist", async () => {
    const env = withUv();
    const tools = join(root, "uv tools ąę");
    const opts = {
      dataDir: join(root, "data"),
      env,
      platform: "linux" as const,
      toolDir: async () => tools,
    };
    expect(await uvToolEnvExists(opts)).toBe(false);
    mkdirSync(join(tools, "evoscientist"), { recursive: true });
    expect(await uvToolEnvExists(opts)).toBe(true);
  });

  it("is null when uv does not answer", async () => {
    expect(
      await uvToolEnvExists({
        dataDir: join(root, "data"),
        env: withUv(),
        platform: "linux",
        toolDir: async () => null,
      })
    ).toBeNull();
  });
});
