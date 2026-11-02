// Server-only: the folder a file request may read and write. The browser
// names a project by its handle (its chat assistant's ID, see
// `projectHandle`), never by a path; the folder comes from the local
// backend's registry, so a crafted request can't reach a folder that isn't a
// registered project with its folder in place. Anyone who reaches the backend
// can make an assistant for any folder, so assistants prove nothing here.

import { promises as fs } from "fs";
import { resolve } from "path";
import type { NextRequest } from "next/server";
import { parseProjects, projectHandle, type Project } from "@/lib/projects";
import { forwardToBackend, localBackend } from "@/lib/server/settingsRelay";

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
