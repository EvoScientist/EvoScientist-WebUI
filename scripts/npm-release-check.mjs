// What the release workflow does with a tag before it packs and publishes the
// package to npm (.github/workflows/desktop.yml, jobs `npm-pack` and `npm`):
// - the tag must name package.json's version;
// - a version npm has already is skipped, so a run re-tried after a publish
//   by hand passes without publishing again;
// - a pre-release, or a version below a newer release tag of the repository
//   or below npm's `latest`, stops the job: `npm publish` would move
//   `latest` to it, and `npx @evoscientist/webui@latest` installs `latest`.
//   Publish those by hand with `--tag`. The tags are read from the
//   repository at once; npm's metadata can be a few minutes old.
//
//   node scripts/npm-release-check.mjs <tag> [--tarball <file>]
//
// With --tarball (the publish job), the tarball's own package.json must
// hold this name and version too: that file is what npm publishes.
//
// Prints what it decided, and writes `action=publish` or `action=skip` to
// $GITHUB_OUTPUT when that is set.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY = "https://registry.npmjs.org";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** A version's numbers and whether it is a pre-release; null when `version`
 *  is not a version. */
function parse(version) {
  const m = VERSION.exec(version);
  return m
    ? {
        numbers: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: Boolean(m[4]),
      }
    : null;
}

/** Whether release `a`'s numbers come before `b`'s. `a` is always a release
 *  here, so a pre-release `b` of the same numbers does not count. */
function before(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] < b.numbers[i];
  }
  return false;
}

/**
 * npm's versions of `name` and its `latest` tag, or null when npm has no
 * such package. Any other answer throws, an answer of another shape too:
 * publishing blind could fail later, or move `latest` wrongly.
 * @param {string} name
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [fetchImpl]
 * @param {string} [registry]
 * @returns {Promise<{ versions: string[], latest: string | null } | null>}
 */
export async function npmState(name, fetchImpl = fetch, registry = REGISTRY) {
  const res = await fetchImpl(`${registry}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`the registry answered ${res.status} for ${name}`);
  }
  const doc = await res.json();
  const object = (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const tags = doc?.["dist-tags"];
  if (
    !object(doc) ||
    !object(doc.versions) ||
    (tags !== undefined && !object(tags))
  ) {
    throw new Error(`the registry's answer for ${name} has no versions list`);
  }
  const latest = tags?.latest ?? null;
  if (latest !== null && (typeof latest !== "string" || !parse(latest))) {
    throw new Error(`npm's latest for ${name} is not a version: ${latest}`);
  }
  return { versions: Object.keys(doc.versions), latest };
}

/** The `v*` tags in `git ls-remote --tags --refs` output. */
export function releaseTags(lsRemote) {
  return lsRemote
    .split("\n")
    .map((line) => /\trefs\/tags\/(v[^\s]+)$/.exec(line)?.[1])
    .filter((tag) => tag !== undefined);
}

/**
 * "publish" or "skip" for `tag`, given package.json's `version`, npm's state
 * (npmState) and the repository's tags; throws when the tag must not
 * publish.
 * @param {string} tag
 * @param {string} version
 * @param {{ versions: string[], latest: string | null } | null} npm
 * @param {string[]} tags
 * @returns {"publish" | "skip"}
 */
export function releaseAction(tag, version, npm, tags) {
  if (tag !== `v${version}`) {
    throw new Error(
      `the tag ${tag} is not v${version}, the version in package.json`
    );
  }
  if (npm?.versions.includes(version)) return "skip";
  const own = parse(version);
  if (!own || own.pre) {
    throw new Error(
      `${version} is a pre-release: publish it by hand with --tag, so latest stays on a release`
    );
  }
  const newer = tags.find((t) => {
    const other = parse(t.slice(1));
    return other !== null && !other.pre && before(own, other);
  });
  if (newer) {
    throw new Error(
      `${newer} is newer than ${tag}: publish ${version} by hand with --tag if it should be on npm, so latest stays on ${newer}`
    );
  }
  const latest = npm?.latest ? parse(npm.latest) : null;
  if (latest && before(own, latest)) {
    throw new Error(
      `${version} is below npm's latest ${npm.latest}: publish it by hand with --tag, so latest stays on ${npm.latest}`
    );
  }
  return "publish";
}

/**
 * Why the tarball is not this package's, or null. `packed` holds its entries
 * and the name and version npm reads from it. npm takes the manifest from any
 * one folder of a tarball, the last one it meets, and reads
 * `package/./package.json` or `package//package.json` as
 * `package/package.json`: every entry must be a plain path in `package/`,
 * once.
 * @param {{ entries: string[], manifest: any } | null} packed
 * @param {{ name: string, version: string }} pkg
 * @returns {string | null}
 */
export function packedProblem(packed, pkg) {
  if (packed === null || typeof packed !== "object") {
    return "the tarball could not be read";
  }
  const seen = new Set();
  for (const entry of packed.entries) {
    if (!entry.startsWith("package/")) {
      return `the tarball has ${entry} outside package/`;
    }
    // A folder's entry ends in a slash.
    const inner = entry
      .split("/")
      .slice(1, entry.endsWith("/") ? -1 : undefined);
    if (
      entry.includes("\\") ||
      inner.some((part) => part === "" || part === "." || part === "..")
    ) {
      return `the tarball has an odd entry: ${entry}`;
    }
    if (seen.has(entry)) return `the tarball has ${entry} twice`;
    seen.add(entry);
  }
  const manifest = packed.manifest;
  if (typeof manifest !== "object" || manifest === null) {
    return "the tarball has no package.json";
  }
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
    return `the tarball holds ${manifest.name}@${manifest.version}, not ${pkg.name}@${pkg.version}`;
  }
  return null;
}

/**
 * The tag and the optional tarball from the command line. A `--tarball`
 * without a file, or any other word, is refused: it would skip a check.
 * @param {string[]} args
 * @returns {{ tag: string, tarball: string | undefined }}
 */
export function parseArgs(args) {
  const [tag, ...rest] = args;
  if (!tag || tag.startsWith("--"))
    throw new Error("usage: npm-release-check.mjs <tag> [--tarball <file>]");
  if (rest.length === 0) return { tag, tarball: undefined };
  if (
    rest[0] === "--tarball" &&
    rest.length === 2 &&
    !rest[1].startsWith("--")
  ) {
    return { tag, tarball: rest[1] };
  }
  throw new Error(`--tarball takes one file: ${rest.join(" ")}`);
}

/** Room for the file lists of a large package (the default is 1 MiB). */
const READ = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };

/**
 * A tarball's entries (`tar -tzf`) and the name and version npm itself reads
 * from it (`npm pack <file> --dry-run`, the reader `npm publish` uses; no
 * package script runs).
 * @param {string} file
 * @returns {{ entries: string[], manifest: { name: string, version: string } | null }}
 */
export function readPackedFile(file) {
  const entries = execFileSync("tar", ["-tzf", file], READ)
    .split("\n")
    .filter((entry) => entry !== "");
  const [seen] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", resolve(file), "--dry-run", "--json", "--ignore-scripts"],
      READ
    )
  );
  return {
    entries,
    manifest: seen ? { name: seen.name, version: seen.version } : null,
  };
}

/**
 * Decides for `tag` and writes the decision to the step's output; with
 * `tarball`, checks it holds this package before saying to publish.
 * @param {{
 *   tag: string,
 *   pkg: { name: string, version: string },
 *   readNpm: () => Promise<{ versions: string[], latest: string | null } | null>,
 *   readTags: () => string[],
 *   tarball?: string,
 *   readPacked?: (file: string) => { entries: string[], manifest: any },
 *   writeOutput: (line: string) => void,
 *   log: (line: string) => void,
 * }} deps
 */
export async function main({
  tag,
  pkg,
  readNpm,
  readTags,
  tarball,
  readPacked,
  writeOutput,
  log,
}) {
  const action = releaseAction(tag, pkg.version, await readNpm(), readTags());
  if (action === "publish" && tarball !== undefined) {
    const problem = packedProblem(readPacked?.(tarball) ?? null, pkg);
    if (problem) throw new Error(problem);
  }
  log(
    action === "skip"
      ? `${pkg.name}@${pkg.version} is on npm already: nothing to publish.`
      : `${pkg.name}@${pkg.version} goes to npm.`
  );
  writeOutput(`action=${action}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  const run = async () => {
    const { tag, tarball } = parseArgs(process.argv.slice(2));
    await main({
      tag,
      pkg,
      tarball,
      readPacked: readPackedFile,
      readNpm: () => npmState(pkg.name),
      readTags: () =>
        releaseTags(
          execFileSync("git", ["ls-remote", "--tags", "--refs", "origin"], {
            encoding: "utf8",
          })
        ),
      writeOutput: (line) => {
        if (process.env.GITHUB_OUTPUT) {
          appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
        }
      },
      log: (line) => console.log(line),
    });
  };
  run().catch((e) => {
    console.log(`::error::${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
