import { CHAT_GRAPH_ID, workspaceAssistantId } from "@/lib/workspaceAssistant";

/** A folder the backend serves, from its `GET /api/workspaces`. */
export interface Project {
  /** The project root as the core writes it into thread metadata. */
  key: string;
  /** The folder's label; two projects can share one. */
  name: string;
  /** The folder no longer exists: nothing runs in it until it is back. */
  missing: boolean;
}

export type ProjectsState =
  /** Not known yet: nothing runs until it is. */
  | { status: "pending" }
  /** A core without `GET /api/workspaces` (older than one backend for
   *  every project): this WebUI can't run on it. */
  | { status: "unsupported" }
  /** The registered projects, by name. */
  | { status: "ready"; projects: readonly Project[] };

/** Projects by name, then path: the backend's order is not a contract. */
export function compareProjects(a: Project, b: Project): number {
  return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}

/** The projects in a `GET /api/workspaces` body, sorted; entries without a
 *  folder are dropped. */
export function parseProjects(body: unknown): Project[] {
  const rows = (body as { workspaces?: unknown } | null)?.workspaces;
  if (!Array.isArray(rows)) {
    throw new Error("The backend's project list is malformed.");
  }
  const projects: Project[] = [];
  for (const row of rows) {
    const value = row as {
      workspace_dir?: unknown;
      name?: unknown;
      missing?: unknown;
    } | null;
    if (typeof value?.workspace_dir !== "string" || !value.workspace_dir) {
      continue;
    }
    projects.push({
      key: value.workspace_dir,
      name:
        typeof value.name === "string" && value.name
          ? value.name
          : value.workspace_dir,
      missing: value.missing === true,
    });
  }
  return projects.sort(compareProjects);
}

/**
 * The projects the backend at `deploymentUrl` serves, or null when it has no
 * `GET /api/workspaces`. Throws when the backend can't be reached, so the
 * caller can retry.
 */
export async function fetchProjects(
  deploymentUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<Project[] | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const res = await fetch(
    `${deploymentUrl.replace(/\/$/, "")}/api/workspaces`,
    { headers, cache: "no-store", signal }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseProjects(await res.json());
}

/** The project registered at `key`, if any. */
export function findProject(
  state: ProjectsState,
  key: string | null | undefined
): Project | null {
  if (state.status !== "ready" || !key) return null;
  return state.projects.find((project) => project.key === key) ?? null;
}

/** The project a new conversation starts in: the first of `preferred` that
 *  is registered and has its folder, else the first such project by name. */
export function pickProject(
  state: ProjectsState,
  preferred: ReadonlyArray<string | null | undefined>
): Project | null {
  if (state.status !== "ready") return null;
  for (const key of preferred) {
    const project = findProject(state, key);
    if (project && !project.missing) return project;
  }
  return state.projects.find((project) => !project.missing) ?? null;
}

/** The core's graphs (its langgraph.json): each has an assistant per
 *  project, and what runs on any of them is the project's. */
export const PROJECT_GRAPHS = [
  "EvoScientist",
  "scheduler",
  "writing-agent",
  "data-analysis-agent",
  "expert-container-async",
  "evomemory-subagent-worker",
  "evomemory-turn-worker",
  "evomemory-observation-linker",
  "evomemory-autoskills",
  "proactive",
];

/** The IDs of the project at `key`'s assistants, one per graph. */
export function projectAssistantIds(key: string): string[] {
  return PROJECT_GRAPHS.map((graph) => workspaceAssistantId(graph, key));
}

/** Each of `projects`' assistants, mapped to its project: what runs on an
 *  assistant is its project's, as the backend decides. */
export function projectsByAssistant(
  projects: readonly Project[]
): Map<string, Project> {
  const map = new Map<string, Project>();
  for (const project of projects) {
    for (const id of projectAssistantIds(project.key)) map.set(id, project);
  }
  return map;
}

/** The tasks that run on one of `projects`' assistants. A task of a folder
 *  that isn't a project is left out: it comes back with the project. */
export function registeredTasks<T extends { assistantId: string }>(
  tasks: readonly T[],
  projects: readonly Project[]
): T[] {
  const byAssistant = projectsByAssistant(projects);
  return tasks.filter((task) => byAssistant.has(task.assistantId));
}

/** The handle the WebUI's file routes take for a project: its chat
 *  assistant's ID. The server finds the project whose ID it is. */
export function projectHandle(key: string): string {
  return workspaceAssistantId(CHAT_GRAPH_ID, key);
}

const LAST_USED_KEY = "evoscientist-last-project";

/** The stored map of deployment URL to project; empty when it is missing
 *  or damaged, so a bad entry is replaced by the next write. */
function readLastUsedMap(): Record<string, unknown> {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(LAST_USED_KEY) ?? "{}"
    );
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The project last used on the backend at `deploymentUrl`, from this
 *  browser's storage. */
export function readLastUsedProject(deploymentUrl: string): string | null {
  const key = readLastUsedMap()[deploymentUrl];
  return typeof key === "string" && key ? key : null;
}

/** Remember `key` as the project last used on `deploymentUrl`; null
 *  forgets it. Storage that is full or off only loses the preference. */
export function writeLastUsedProject(
  deploymentUrl: string,
  key: string | null
) {
  const next = { ...readLastUsedMap(), [deploymentUrl]: key };
  if (key === null) delete next[deploymentUrl];
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(next));
  } catch {
    // Kept for this page only.
  }
}
