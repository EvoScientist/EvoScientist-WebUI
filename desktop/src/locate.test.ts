import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findUv, locateEvoSci } from "./locate";

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
    expect(
      await locateEvoSci({
        dataDir: join(root, "data"),
        env: { PATH: "" },
        platform: "linux",
        home: join(root, "home"),
        toolBinDir,
      })
    ).toEqual({ path: local, via: "local-bin" });
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
