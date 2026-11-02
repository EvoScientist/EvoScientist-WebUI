// Build-time rules for the packaged app, used by scripts/builder.mjs and the
// release workflow (.github/workflows/desktop.yml).
// - One version: the app's version is the WebUI version it bundles, the
//   root package.json's. Release commits bump only that file, so the build
//   stamps it into the packaged package.json (`extraMetadata.version`);
//   desktop/package.json's own version is never used.
// - A release tag names that version.
// - Desktop files go out only once `evoscientist.release` is true, which the
//   pull request that moves the core range to a release with the Windows
//   clean stop (EvoScientist#712, v0.4.0 or later) sets.
import { compareReleases, installVersion, parseRelease } from "./versions";

/** The first core version a desktop release may install. */
export const FIRST_RELEASE_CORE = "0.4.0";

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

/** Why the `release` flag cannot be on with this core range, or null. */
export function releaseFlagProblem(meta: {
  coreRange: string;
  release?: unknown;
}): string | null {
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
