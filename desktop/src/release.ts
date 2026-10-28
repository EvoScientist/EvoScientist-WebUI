// The newest core release inside the app's range (W03c, How > Core update):
// the version the app passes to `EvoSci update --version`. It reads the
// package index's JSON simple API, on the index `EvoSci update` itself uses:
// the Tsinghua mirror with `mirror: cn` in config.yaml, else PyPI (the update
// has no `--cn`, so the first-launch answer and "Retry with mainland China
// mirrors" do not reach it). Pre-releases, dev and local versions are
// skipped, as the core skips them, and versions compare as release numbers:
// the mirror lists them sorted as strings. main.ts passes Electron's
// `net.fetch`, which follows the system proxy, PAC files and the Windows
// certificate store. The core's own downloads use Python's `getproxies()`
// (environment, else the Windows registry proxy, no PAC) and uv's system
// certificates, so on a PAC-only network the lookup can work and the update
// still fail with `download_failed`.
import { compareReleases, inRange, parseRelease } from "./versions";

/** The core's index URLs (`update_check.py` PYPI_SIMPLE / CN_SIMPLE). */
export const PYPI_SIMPLE = "https://pypi.org/simple";
export const CN_SIMPLE = "https://pypi.tuna.tsinghua.edu.cn/simple";
export const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";

/** The whole lookup, the answer's body included. */
export const LOOKUP_TIMEOUT_MS = 15_000;

/** The project's page on the index `EvoSci update` uses. */
export const indexUrl = (cn: boolean) =>
  `${cn ? CN_SIMPLE : PYPI_SIMPLE}/evoscientist/`;

/** The part of a fetch the lookup uses (Electron's `net.fetch` in the app). */
export type Fetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Lookup =
  | { ok: true; version: string; url: string }
  /** `answered`: the index answered, but with no release to use (an HTTP
   *  error, no version list, none inside the range); else no answer came.
   *  `listed`: the versions it listed, when it did. */
  | {
      ok: false;
      reason: string;
      url: string;
      answered: boolean;
      listed?: string[];
    };

/** The version in a distribution's file name: `evoscientist-0.3.8.tar.gz`,
 *  `evoscientist-0.3.8-py3-none-any.whl` (the project name has no hyphen). */
function fileVersion(filename: string): string | null {
  const rest = filename.slice(filename.indexOf("-") + 1);
  if (!filename.includes("-") || !rest) return null;
  if (rest.endsWith(".whl")) return rest.split("-")[0] || null;
  const m = /^(.+?)\.(?:tar\.gz|tar\.bz2|zip)$/.exec(rest);
  return m ? m[1] : null;
}

/**
 * The versions whose every file is yanked. The JSON simple API still lists
 * them in `versions` (the yank shows only on `files[].yanked`, true or a
 * reason), and `--version` installs a yanked release when it is pinned.
 */
export function yankedVersions(files: unknown): Set<string> {
  const state = new Map<string, boolean>();
  if (!Array.isArray(files)) return new Set();
  for (const f of files as { filename?: unknown; yanked?: unknown }[]) {
    if (typeof f?.filename !== "string") continue;
    const version = fileVersion(f.filename);
    if (!version) continue;
    const yanked = f.yanked === true || typeof f.yanked === "string";
    state.set(version, (state.get(version) ?? true) && yanked);
  }
  return new Set([...state].filter(([, y]) => y).map(([v]) => v));
}

/** The highest plain release inside the range, or null when none is. */
export function newestInRange(
  versions: string[],
  range: string
): string | null {
  let best: { version: string; release: number[] } | null = null;
  for (const version of versions) {
    const release = parseRelease(version);
    if (!release || !inRange(version, range)) continue;
    if (!best || compareReleases(release, best.release) > 0)
      best = { version, release };
  }
  return best?.version ?? null;
}

/** Looks up the newest release in the range; a failure says why. */
export async function lookupNewest(opts: {
  fetch: Fetch;
  cn: boolean;
  range: string;
  timeoutMs?: number;
}): Promise<Lookup> {
  const url = indexUrl(opts.cn);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? LOOKUP_TIMEOUT_MS
  );
  let body: unknown;
  try {
    const res = await opts.fetch(url, {
      headers: { Accept: SIMPLE_JSON },
      signal: controller.signal,
    });
    if (!res.ok)
      return { ok: false, reason: `HTTP ${res.status}`, url, answered: true };
    try {
      body = await res.json();
    } catch (e) {
      // A body cut off by the timeout is no answer, not a bad one.
      if (controller.signal.aborted) throw e;
      return {
        ok: false,
        reason: "the answer is not JSON",
        url,
        answered: true,
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `no answer within ${(opts.timeoutMs ?? LOOKUP_TIMEOUT_MS) / 1000} s`
        : e instanceof Error
        ? e.message
        : String(e),
      url,
      answered: false,
    };
  } finally {
    clearTimeout(timer);
  }
  const versions = (body as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions))
    return {
      ok: false,
      reason: "the answer has no version list",
      url,
      answered: true,
    };
  const listed = versions.filter((v): v is string => typeof v === "string");
  const yanked = yankedVersions((body as { files?: unknown }).files);
  const version = newestInRange(
    listed.filter((v) => !yanked.has(v)),
    opts.range
  );
  return version
    ? { ok: true, version, url }
    : {
        ok: false,
        reason: `no release inside ${opts.range} is listed${
          yanked.size > 0 ? ` (yanked: ${[...yanked].join(", ")})` : ""
        }`,
        url,
        answered: true,
        listed,
      };
}
