import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { configDir, globalDataDir, sharedDirFromEnv } from "@/lib/server/paths";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sharedDirFromEnv", () => {
  const read = (value: string | undefined) =>
    sharedDirFromEnv("DIR", value === undefined ? {} : { DIR: value });

  it("treats unset, empty and Python-whitespace-only values as unset", () => {
    expect(read(undefined)).toBeNull();
    expect(read("")).toBeNull();
    expect(read("  \t")).toBeNull();
    // U+0085 is whitespace to Python's str.strip(), which the backend uses.
    expect(read("\x85")).toBeNull();
  });

  it("expands a leading ~ alone or before a separator", () => {
    expect(read("~")).toBe(resolve(homedir()));
    expect(read("~/evo")).toBe(resolve(homedir(), "evo"));
    expect(read(`~${sep}evo`)).toBe(resolve(homedir(), "evo"));
  });

  it("leaves ~name as a relative path, as the backend does", () => {
    expect(read("~alice/evo")).toBe(resolve("~alice/evo"));
  });

  it("resolves a relative path against the current folder", () => {
    expect(read("data dir ą")).toBe(resolve(process.cwd(), "data dir ą"));
  });

  it("keeps an absolute path", () => {
    const abs = resolve("/tmp/evo data");
    expect(read(abs)).toBe(abs);
  });
});

describe("globalDataDir", () => {
  it("defaults to ~/.evoscientist", () => {
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", "");
    expect(globalDataDir()).toBe(join(homedir(), ".evoscientist"));
  });

  it("follows EVOSCIENTIST_DATA_DIR", () => {
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", "/srv/evo");
    expect(globalDataDir()).toBe(resolve("/srv/evo"));
  });
});

describe("configDir", () => {
  it("defaults to ~/.config/evoscientist", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(configDir()).toBe(join(homedir(), ".config", "evoscientist"));
  });

  it("follows XDG_CONFIG_HOME", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/srv/xdg");
    expect(configDir()).toBe(join(resolve("/srv/xdg"), "evoscientist"));
  });
});

describe("the skills and memory folders", () => {
  // `~name` is a relative folder to the backend, not a user's home.
  const data = "~alice/evo";

  it("put memories under the data folder by the same rule", async () => {
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", data);
    vi.stubEnv("EVOSCIENTIST_MEMORIES_DIR", "");
    vi.stubEnv("EVOSCIENTIST_MEMORY_DIR", "");
    const { memoryDirPath } = await import("@/lib/server/memory");
    expect(memoryDirPath()).toBe(join(resolve(data), "memories"));
  });

  it("install skills under the data folder by the same rule", async () => {
    vi.stubEnv("EVOSCIENTIST_DATA_DIR", data);
    vi.resetModules();
    const { SKILLS_INSTALL_DIR } = await import("@/lib/server/skills");
    expect(SKILLS_INSTALL_DIR).toBe(join(resolve(data), "skills"));
  });
});
