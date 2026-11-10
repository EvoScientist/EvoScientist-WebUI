// Server-only: the folder a file request may read and write. The browser
// names a project by its handle (its chat assistant's ID, see
// `projectHandle`), never by a path; the folder comes from the local
// backend's registry, so a crafted request can't reach a folder that isn't a
// registered project with its folder in place. Anyone who reaches the backend
// can make an assistant for any folder, so assistants prove nothing here.
// One user per machine is assumed, as the backend does (it trusts every
// program on its machine): nothing checks that the process on the port is
// this user's backend.

import { promises as fs } from "fs";
import { resolve } from "path";
import type { NextRequest } from "next/server";
import { parseProjects, projectHandle, type Project } from "@/lib/projects";
import {
  forwardToBackend,
  instanceOf,
  localBackend,
  readLocalSecret,
  type ForwardResult,
  type LocalBackend,
} from "@/lib/server/settingsRelay";

/** How long one read of the registry answers for: a removed project stops
 *  serving files within this, or, while a read is still running, once it
 *  settles (at most `REGISTRY_TIMEOUT_MS`). */
const REGISTRY_CACHE_MS = 1_000;

/** How long the file routes and the `/` menu wait for the registry. */
const REGISTRY_TIMEOUT_MS = 5_000;

const UNREACHABLE =
  "The local EvoScientist backend can't be reached, so its projects' files can't be shown.";

let cached: {
  at: number;
  /** The backend's port the read went to. */
  port: number;
  projects: Promise<Project[]>;
  pending: boolean;
} | null = null;

/** Forget the cached registry (tests). */
export function resetProjectRegistryCache() {
  cached = null;
}

/** The local backend's registered projects, read at most once a second
 *  (counted from when a read settles); a read still running answers every
 *  request until it settles. A read answers only for the port it went to:
 *  a backend on another port is asked itself. */
export function localProjects(): Promise<Project[]> {
  const backend = localBackend();
  if (
    cached &&
    cached.port === backend.port &&
    (cached.pending || Date.now() - cached.at < REGISTRY_CACHE_MS)
  )
    return cached.projects;
  const projects = (async () => {
    const result = await forwardToBackend(backend, "GET", "/api/workspaces", {
      timeoutMs: REGISTRY_TIMEOUT_MS,
    });
    if (!result.ok || !result.response.ok) {
      throw new ProjectRefusedError(UNREACHABLE);
    }
    try {
      return parseProjects(await result.response.json());
    } catch {
      // A body cut off (the timeout), or one that isn't a registry.
      throw new ProjectRefusedError(UNREACHABLE);
    }
  })();
  const entry = { at: 0, port: backend.port, projects, pending: true };
  cached = entry;
  // A failed read isn't kept: the next request asks again.
  projects.then(
    () => {
      entry.at = Date.now();
      entry.pending = false;
    },
    () => {
      if (cached === entry) cached = null;
    }
  );
  return projects;
}

/** The longest folder path taken. */
const MAX_PATH = 4096;

/** `value` as a folder path a request may name, or null: a non-empty
 *  string, not too long, without control characters. As named: the backend
 *  reads the path (a project's key is its exact folder, spaces and all). */
export function requestFolder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001f]/.test(value);
  if (!value.trim() || value.length > MAX_PATH || control) return null;
  return value;
}

/** How long the move probe waits for the backend. */
const MOVE_PROBE_TIMEOUT_MS = 5_000;

/** How long a "no move" answer holds: a core updated in place starts again
 *  under the same local secret, so as the same instance. */
const NO_MOVE_CACHE_MS = 60_000;

/** Why the backend couldn't be asked about the move. */
export type MoveProbeFailure = Extract<ForwardResult, { ok: false }>["refusal"];

let moveProbe: {
  port: number;
  instance: string;
  supported: Promise<boolean | MoveProbeFailure | null>;
  /** Until when it answers: for good while the probe runs and for a "yes",
   *  a minute for a "no". */
  until: number;
} | null = null;

/** Forget the cached move probe (tests). */
export function resetMoveProbeCache() {
  moveProbe = null;
}

/**
 * Whether the local backend can move a project (`POST /api/workspaces/move`),
 * asked without the local secret: a backend with the route refuses that with
 * 403 `local_secret_required` before anything runs, one without it answers
 * 404 (a GET can't tell: the backend answers 404 for a method a route doesn't
 * take). Asked once per backend instance (its port and local secret); a "no"
 * is asked again after a minute, an answer that is neither is not kept.
 * False without a local secret: nothing can be moved from here then. Why
 * not, when the backend can't be reached: whether it can move is unknown.
 */
export async function moveSupported(): Promise<boolean | MoveProbeFailure> {
  const backend = localBackend();
  const secret = readLocalSecret(backend);
  if (secret === null) return false;
  const instance = instanceOf(secret);
  const entry = moveProbe;
  if (
    entry &&
    entry.port === backend.port &&
    entry.instance === instance &&
    Date.now() < entry.until
  )
    return (await entry.supported) ?? false;
  const next: NonNullable<typeof moveProbe> = {
    port: backend.port,
    instance,
    supported: probeMove(backend),
    until: Infinity,
  };
  moveProbe = next;
  const answer = await next.supported;
  if (typeof answer !== "boolean") {
    if (moveProbe === next) moveProbe = null;
  } else if (!answer) {
    next.until = Date.now() + NO_MOVE_CACHE_MS;
  }
  return answer ?? false;
}

/** True for the move route's refusal, false for no route, why not when the
 *  backend can't be reached, null for any other answer. */
async function probeMove(
  backend: LocalBackend
): Promise<boolean | MoveProbeFailure | null> {
  const result = await forwardToBackend(
    backend,
    "POST",
    "/api/workspaces/move",
    { body: "{}", timeoutMs: MOVE_PROBE_TIMEOUT_MS }
  );
  if (!result.ok) return result.refusal;
  const { status } = result.response;
  if (status === 404) return false;
  if (status !== 403) return null;
  const body = (await result.response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return body?.error === "local_secret_required" ? true : null;
}

/** A file request for no project this machine's backend serves. */
export class ProjectRefusedError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSED =
  "This project isn't served here: it isn't registered with the local backend, or its folder is missing.";

/**
 * The folder of the project the request names in `?project=`, canonical
 * (realpath), so every containment check compares against the real root.
 * One error for every refusal: an unknown handle, an unregistered project
 * and a missing folder look alike.
 */
export async function projectDir(request: NextRequest): Promise<string> {
  const handle = request.nextUrl.searchParams.get("project") ?? "";
  if (!UUID.test(handle)) throw new ProjectRefusedError(REFUSED);
  const project = (await localProjects()).find(
    (p) => !p.missing && projectHandle(p.key) === handle.toLowerCase()
  );
  if (!project) throw new ProjectRefusedError(REFUSED);
  const root = resolve(project.key);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new ProjectRefusedError(REFUSED);
  return fs.realpath(root);
}
