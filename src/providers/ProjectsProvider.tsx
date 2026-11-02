"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { retryWithBackoff } from "@/lib/retry";
import {
  fetchProjects,
  findProject,
  pickProject,
  readLastUsedProject,
  writeLastUsedProject,
  type Project,
  type ProjectsState,
} from "@/lib/projects";

/** Whether this page can show a project's files: the WebUI's file routes
 *  read this machine's disk for the projects this machine's backend serves,
 *  so only when the page talks to that backend. */
export type FilesAccess = "pending" | "here" | "elsewhere";

export interface ProjectsContextValue {
  /** The last project list the backend gave. */
  projects: ProjectsState;
  /** True while the list is being read again; nothing runs meanwhile. */
  refreshing: boolean;
  /** The last failure while reading the list, while it is retried. */
  error: string | null;
  /**
   * Whether a run may start now. Closed the moment a read starts; opened
   * only after the render that carries its answer, so a caller that sees it
   * open also holds that answer's projects.
   */
  isReady: () => boolean;
  /** Read the list again; resolves with the answer it publishes. */
  refresh: () => Promise<ProjectsState>;
  /**
   * The current project: the one selected (the open conversation's), else
   * the one last used, else the first by name; never one whose folder is
   * missing. Null when no project can run.
   */
  current: Project | null;
  /** Make `key` the current project; `remember` also makes it the last used
   *  (a pick, or a message sent in it). */
  selectProject: (key: string, options?: { remember?: boolean }) => void;
  files: FilesAccess;
}

export const ProjectsContext = createContext<ProjectsContextValue | null>(null);

const MAX_RETRY_MS = 10_000;
/** Statuses that say "not now" rather than "no": asked again. */
const RETRY_STATUSES = (status: number) =>
  status >= 500 || status === 408 || status === 429;

/** How long an instance read may take before it counts as failed. */
const INSTANCE_TIMEOUT_MS = 8_000;

async function readInstance(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<string | null> {
  // Aborted with `signal`, or after the timeout: a backend that hangs fails.
  signal.throwIfAborted();
  const read = new AbortController();
  const stop = () => read.abort();
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, INSTANCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers,
      cache: "no-store",
      signal: read.signal,
    });
    // A backend that failed to answer, was busy, or whose answer was cut
    // short is asked again; one that answered without an instance, or with
    // something that isn't JSON, has none.
    if (RETRY_STATUSES(res.status)) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) return null;
    let body: { instance?: unknown } | null;
    try {
      body = (await res.json()) as { instance?: unknown } | null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    return typeof body?.instance === "string" && body.instance
      ? body.instance
      : null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** The instance of the page's backend against this machine's: equal and
 *  known means the file routes read the page's projects. Throws when a read
 *  fails. */
async function checkFiles(
  deploymentUrl: string,
  apiKey: string,
  signal: AbortSignal
): Promise<FilesAccess> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const remote = await readInstance(
    `${deploymentUrl.replace(/\/$/, "")}/api/instance`,
    headers,
    signal
  );
  if (remote === null) return "elsewhere";
  // Read after the page's backend answered: a backend starting here writes
  // its secret before it serves, so it is there by now.
  const local = await readInstance("/api/workspace/instance", {}, signal);
  return remote === local ? "here" : "elsewhere";
}

async function readProjects(
  deploymentUrl: string,
  apiKey: string,
  signal: AbortSignal
): Promise<ProjectsState> {
  const projects = await fetchProjects(deploymentUrl, apiKey, signal);
  return projects ? { status: "ready", projects } : { status: "unsupported" };
}

interface ProviderState {
  backend: string;
  projects: ProjectsState;
  files: FilesAccess;
  refreshing: boolean;
  error: string | null;
  /** The project selected on this backend, if any. */
  selected: string | null;
  /** The project last used on this backend, from this browser's storage. */
  lastUsed: string | null;
}

function initialState(backend: string, deploymentUrl: string): ProviderState {
  return {
    backend,
    projects: { status: "pending" },
    files: "pending",
    refreshing: true,
    error: null,
    selected: null,
    lastUsed:
      typeof window === "undefined" ? null : readLastUsedProject(deploymentUrl),
  };
}

/**
 * The backend's projects for the WebUI. On another backend it starts over:
 * the last backend's answer is dropped in the same render, so nothing renders
 * or runs on it while the new one is read.
 */
export function ProjectsProvider({
  children,
  deploymentUrl,
  apiKey,
}: {
  children: ReactNode;
  deploymentUrl: string;
  apiKey: string;
}) {
  const backend = `${deploymentUrl}\n${apiKey}`;
  const [state, setState] = useState<ProviderState>(() =>
    initialState(backend, deploymentUrl)
  );
  if (state.backend !== backend) {
    setState(initialState(backend, deploymentUrl));
  }
  // Read by a read that ends after the render it started in.
  const stateRef = useRef(state);
  stateRef.current = state;

  const gateRef = useRef(false);
  // One read at a time; a request during it reads once more afterwards, so
  // the published answer is never older than the latest request.
  const runningRef = useRef<{ promise: Promise<ProjectsState> } | null>(null);
  const againRef = useRef(false);
  // Made per mount and per backend: the last one's read is aborted, as is
  // the first mount's under React's development double mount.
  const controllerRef = useRef<{
    backend: string;
    controller: AbortController;
  } | null>(null);

  const refresh = useCallback((): Promise<ProjectsState> => {
    // A `refresh` kept from before a switch to another backend (a request
    // that failed late) reads nothing: the current backend's is in charge.
    const current = controllerRef.current;
    if (current?.backend !== backend) {
      return Promise.resolve({ status: "pending" });
    }
    const { controller } = current;
    gateRef.current = false;
    setState((prev) =>
      prev.refreshing ? prev : { ...prev, refreshing: true }
    );
    if (runningRef.current) {
      againRef.current = true;
      return runningRef.current.promise;
    }
    const run: { promise: Promise<ProjectsState> } = {
      promise: Promise.resolve({ status: "pending" }),
    };
    run.promise = (async () => {
      let answer: ProjectsState | null = null;
      do {
        againRef.current = false;
        answer = await retryWithBackoff(
          () => readProjects(deploymentUrl, apiKey, controller.signal),
          controller.signal,
          MAX_RETRY_MS,
          (error) =>
            setState((prev) => ({
              ...prev,
              error: error instanceof Error ? error.message : String(error),
            }))
        );
      } while (answer && !controller.signal.aborted && againRef.current);
      // Done before publishing, in the same step: a request from here on
      // starts a new read rather than joining this finished one.
      if (runningRef.current === run) runningRef.current = null;
      if (!answer || controller.signal.aborted) {
        return { status: "pending" } as ProjectsState;
      }
      const published = answer;
      // A project no longer on the list is forgotten: added again, it is a
      // new project, current only when picked. The stored one only when it
      // is this page's: another tab may have just picked one this list
      // doesn't have yet.
      const forget = (key: string | null) =>
        key !== null &&
        published.status === "ready" &&
        !findProject(published, key);
      const lastUsed = stateRef.current.lastUsed;
      if (forget(lastUsed) && readLastUsedProject(deploymentUrl) === lastUsed) {
        writeLastUsedProject(deploymentUrl, null);
      }
      setState((prev) => ({
        ...prev,
        projects: published,
        refreshing: false,
        error: null,
        selected: forget(prev.selected) ? null : prev.selected,
        lastUsed: forget(prev.lastUsed) ? null : prev.lastUsed,
      }));
      return published;
    })();
    runningRef.current = run;
    return run.promise;
  }, [deploymentUrl, apiKey, backend]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = { backend, controller };
    runningRef.current = null;
    againRef.current = false;
    void refresh();
    return () => {
      controller.abort();
      if (controllerRef.current?.controller === controller) {
        controllerRef.current = null;
      }
    };
  }, [refresh, backend]);

  // Whether this page shows files, asked once per backend and apart from
  // the project list, which it never holds up. Only an answer decides: a
  // failed read leaves it pending and is asked again, with backoff.
  useEffect(() => {
    const controller = new AbortController();
    const publish = (files: FilesAccess) =>
      setState((prev) =>
        prev.backend !== backend || prev.files === files
          ? prev
          : { ...prev, files }
      );
    void retryWithBackoff(
      () => checkFiles(deploymentUrl, apiKey, controller.signal),
      controller.signal,
      MAX_RETRY_MS
    ).then((files) => {
      if (files && !controller.signal.aborted) publish(files);
    });
    return () => controller.abort();
  }, [deploymentUrl, apiKey, backend]);

  // Open the gate only once the answer has rendered (see `isReady`).
  useLayoutEffect(() => {
    gateRef.current = state.projects.status !== "pending" && !state.refreshing;
  }, [state.projects, state.refreshing]);

  const isReady = useCallback(() => gateRef.current, []);

  const selectProject = useCallback(
    (key: string, options: { remember?: boolean } = {}) => {
      if (options.remember) writeLastUsedProject(deploymentUrl, key);
      setState((prev) =>
        prev.selected === key && (!options.remember || prev.lastUsed === key)
          ? prev
          : {
              ...prev,
              selected: key,
              lastUsed: options.remember ? key : prev.lastUsed,
            }
      );
    },
    [deploymentUrl]
  );

  const current = useMemo(
    () => pickProject(state.projects, [state.selected, state.lastUsed]),
    [state.projects, state.selected, state.lastUsed]
  );

  const value = useMemo(
    () => ({
      projects: state.projects,
      refreshing: state.refreshing,
      error: state.error,
      isReady,
      refresh,
      current,
      selectProject,
      files: state.files,
    }),
    [state, isReady, refresh, current, selectProject]
  );
  return (
    <ProjectsContext.Provider value={value}>
      {children}
    </ProjectsContext.Provider>
  );
}

export function useProjects(): ProjectsContextValue {
  const context = useContext(ProjectsContext);
  if (!context) {
    throw new Error("useProjects must be used within a ProjectsProvider");
  }
  return context;
}
