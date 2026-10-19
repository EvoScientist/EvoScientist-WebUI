import { describe, expect, it } from "vitest";
import { resolve, sep } from "path";
import {
  FOLDER_VARIABLES,
  absoluteFolderEnv,
} from "../../../bin/absolute-folders.mjs";

describe("absoluteFolderEnv (bin launcher)", () => {
  const cwd = resolve("/work/start here");

  it("resolves relative folder variables against the launch folder", () => {
    const env = absoluteFolderEnv(
      { EVOSCIENTIST_DATA_DIR: "data", XDG_CONFIG_HOME: "~alice", PATH: "p" },
      cwd
    );
    expect(env.EVOSCIENTIST_DATA_DIR).toBe(resolve(cwd, "data"));
    expect(env.XDG_CONFIG_HOME).toBe(resolve(cwd, "~alice"));
    expect(env.PATH).toBe("p");
  });

  it("leaves unset, blank, ~ and absolute values alone", () => {
    const abs = resolve("/srv/evo");
    const env = absoluteFolderEnv(
      { EVOSCIENTIST_DATA_DIR: "  ", XDG_CONFIG_HOME: `~${sep}cfg` },
      cwd
    );
    expect(env.EVOSCIENTIST_DATA_DIR).toBe("  ");
    expect(env.XDG_CONFIG_HOME).toBe(`~${sep}cfg`);
    expect(
      absoluteFolderEnv({ XDG_CONFIG_HOME: abs }, cwd).XDG_CONFIG_HOME
    ).toBe(abs);
    expect(absoluteFolderEnv({}, cwd)).toEqual({});
    expect(FOLDER_VARIABLES).toEqual([
      "EVOSCIENTIST_DATA_DIR",
      "XDG_CONFIG_HOME",
    ]);
  });
});
