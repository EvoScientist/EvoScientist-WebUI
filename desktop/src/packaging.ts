// Build-time rules for the packaged app, used by scripts/builder.mjs and the
// release workflow (.github/workflows/desktop.yml).
// - One version: the app's version is the WebUI version it bundles, the
//   root package.json's. Release commits bump only that file, so the build
//   stamps it into the packaged package.json (`extraMetadata.version`);
//   desktop/package.json's own version is never used.
// - A release tag names that version.
// - Desktop files go out only while `evoscientist.release` is true, and the
//   flag may be on only while the core range installs a core with the
//   Windows clean stop (EvoScientist#712, fixed by #716 in v0.4.1).
// - The macOS files go out only while `evoscientist.releaseMac` is true as
//   well: they need the signing secrets, and they are uploaded next to the
//   Windows files, so that flag may be on only while `release` is.
import { basename, join } from "node:path";
import { compareReleases, installVersion, parseRelease } from "./versions";

/** The first core version a desktop release may install. */
export const FIRST_RELEASE_CORE = "0.4.1";

/** The electron-builder arguments that stamp the app's version. */
export function versionArgs(rootVersion: string): string[] {
  if (!parseRelease(rootVersion))
    throw new Error(
      `the root package.json version ${JSON.stringify(
        rootVersion
      )} is not a plain release number`
    );
  return [`-c.extraMetadata.version=${rootVersion}`];
}

/** Why a release tag does not fit the version being built, or null. */
export function tagProblem(tag: string, version: string): string | null {
  return tag === `v${version}`
    ? null
    : `the tag ${tag} does not name the version v${version} (root package.json)`;
}

/** Why the release flags cannot be as they are, or null: `release` with a
 *  core range that installs a core before the first release core, or
 *  `releaseMac` without `release`. */
export function releaseFlagProblem(meta: {
  coreRange: string;
  release?: unknown;
  releaseMac?: unknown;
}): string | null {
  if (meta.releaseMac === true && meta.release !== true)
    return "releaseMac is on, but release is off: the macOS files go out with the Windows release";
  if (meta.release !== true) return null;
  const installs = installVersion(meta.coreRange);
  const release = installs ? parseRelease(installs) : null;
  const first = parseRelease(FIRST_RELEASE_CORE) as number[];
  if (!release || compareReleases(release, first) < 0)
    return `release is on, but the core range ${meta.coreRange} installs ${
      installs ?? "no version"
    }, before ${FIRST_RELEASE_CORE}`;
  return null;
}

/** Where an unpacked build (`npm run pack`) keeps the app: its folder, the
 *  executable and the resources folder. On macOS the folder is the app
 *  bundle, and its executable has the bundle's name. `appDir` names another
 *  copy of the app, as the smoke test's `--app` does. */
export function appLayout(
  platform: NodeJS.Platform,
  releaseDir: string,
  appDir?: string
): { appDir: string; exe: string; resources: string } {
  if (platform === "darwin") {
    const app = appDir ?? join(releaseDir, "mac-arm64", "EvoScientist.app");
    return {
      appDir: app,
      exe: join(app, "Contents", "MacOS", basename(app, ".app")),
      resources: join(app, "Contents", "Resources"),
    };
  }
  const win = platform === "win32";
  const app =
    appDir ?? join(releaseDir, win ? "win-unpacked" : "linux-unpacked");
  return {
    appDir: app,
    exe: join(app, win ? "EvoScientist.exe" : "evoscientist"),
    resources: join(app, "resources"),
  };
}
