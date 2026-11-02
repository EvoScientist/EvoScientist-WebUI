// Fixed projects for tests that mount the chat without a backend. The
// default is one registered project, current, whose files this page reaches.

import type { ReactNode } from "react";
import { vi } from "vitest";
import {
  ProjectsContext,
  type FilesAccess,
  type ProjectsContextValue,
} from "@/providers/ProjectsProvider";
import { folderName } from "@/lib/workspaceAssistant";
import { pickProject, type Project, type ProjectsState } from "@/lib/projects";

/** The project the default mock serves. */
export const TEST_PROJECT = "/home/you/projA";

/** A backend serving the projects at `keys`, none missing. */
export function readyProjects(
  ...keys: Array<string | Project>
): Extract<ProjectsState, { status: "ready" }> {
  return {
    status: "ready",
    projects: keys.map((key) =>
      typeof key === "string"
        ? { key, name: folderName(key), missing: false }
        : key
    ),
  };
}

export function mockProjects(
  projects: ProjectsState = readyProjects(TEST_PROJECT),
  options: { current?: string | null; files?: FilesAccess } = {}
): ProjectsContextValue {
  const current =
    options.current === null
      ? null
      : pickProject(projects, [options.current ?? null]);
  return {
    projects,
    refreshing: false,
    error: null,
    isReady: () => projects.status !== "pending",
    refresh: vi.fn(async () => projects),
    current,
    selectProject: vi.fn(),
    files: options.files ?? "here",
  };
}

export function TestProjectsProvider({
  value,
  children,
}: {
  value?: ProjectsContextValue;
  children: ReactNode;
}) {
  return (
    <ProjectsContext.Provider value={value ?? mockProjects()}>
      {children}
    </ProjectsContext.Provider>
  );
}
