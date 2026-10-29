import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRST_RELEASE_CORE,
  releaseFlagProblem,
  tagProblem,
  versionArgs,
} from "./packaging";

const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
) as {
  evoscientist: { coreRange: string; release?: unknown };
  build: Record<string, unknown> & {
    nsis: Record<string, unknown>;
    publish: Record<string, unknown>;
    extraMetadata: Record<string, unknown>;
  };
};

describe("versionArgs", () => {
  it("stamps the root version into the packaged package.json", () => {
    expect(versionArgs("0.4.2")).toEqual(["-c.extraMetadata.version=0.4.2"]);
  });

  it("refuses a version that is not a plain release", () => {
    expect(() => versionArgs("0.4.2-rc.1")).toThrow(/plain release/);
    expect(() => versionArgs("")).toThrow(/plain release/);
  });
});

describe("tagProblem", () => {
  it("accepts the tag of the version", () => {
    expect(tagProblem("v0.4.2", "0.4.2")).toBeNull();
  });

  it("names a tag on another version", () => {
    expect(tagProblem("v0.4.3", "0.4.2")).toMatch(/v0\.4\.3.*v0\.4\.2/);
    expect(tagProblem("0.4.2", "0.4.2")).not.toBeNull();
  });
});

describe("releaseFlagProblem", () => {
  it("lets the flag be off with any range", () => {
    expect(releaseFlagProblem({ coreRange: ">=0.3.8,<0.4" })).toBeNull();
    expect(
      releaseFlagProblem({ coreRange: ">=0.3.8,<0.4", release: false })
    ).toBeNull();
  });

  it("refuses the flag while the range installs a core before the first release core", () => {
    expect(
      releaseFlagProblem({ coreRange: ">=0.3.8,<0.4", release: true })
    ).toMatch(/installs 0\.3\.8, before 0\.4\.0/);
    expect(releaseFlagProblem({ coreRange: "<0.5", release: true })).toMatch(
      /no version/
    );
  });

  it("accepts the flag once the range installs that core or a newer one", () => {
    expect(
      releaseFlagProblem({
        coreRange: `>=${FIRST_RELEASE_CORE},<0.5`,
        release: true,
      })
    ).toBeNull();
    expect(
      releaseFlagProblem({ coreRange: ">=0.4.1,<0.5", release: true })
    ).toBeNull();
  });

  it("holds for this package.json", () => {
    expect(releaseFlagProblem(pkg.evoscientist)).toBeNull();
  });
});

// Upgrades, uninstall and the update feed depend on these; none may change
// after the first release.
describe("the installer's identity", () => {
  it("keeps the app id, the install folder name and the installer name", () => {
    expect(pkg.build.appId).toBe("com.evoscientist.desktop");
    // A one-click per-user install is named after the package name:
    // %LOCALAPPDATA%\Programs\EvoScientist.
    expect(pkg.build.extraMetadata.name).toBe("EvoScientist");
    expect(pkg.build.nsis.artifactName).toBe("EvoScientist-Setup.${ext}");
  });

  it("installs per user, in the default folder, and keeps user data on uninstall", () => {
    expect(pkg.build.nsis.oneClick).toBe(true);
    expect(pkg.build.nsis.perMachine).toBe(false);
    expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(false);
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it("reads updates from this repository's GitHub Releases", () => {
    expect(pkg.build.publish).toEqual({
      provider: "github",
      owner: "EvoScientist",
      repo: "EvoScientist-WebUI",
    });
  });
});
