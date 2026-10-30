"use client";

import { createContext, useContext } from "react";
import type { Project } from "@/lib/projects";

export interface ProjectDialogsValue {
  /** Ask for a folder to add as a project; `folder` fills the field. */
  openAddProject: (folder?: string) => void;
  /** Confirm removing `project` from the sidebar. */
  openRemoveProject: (project: Project) => void;
}

/** Outside a provider there is nowhere to show the dialogs: the actions do
 *  nothing. */
const NO_DIALOGS: ProjectDialogsValue = {
  openAddProject: () => {},
  openRemoveProject: () => {},
};

export const ProjectDialogsContext =
  createContext<ProjectDialogsValue>(NO_DIALOGS);

export function useProjectDialogs(): ProjectDialogsValue {
  return useContext(ProjectDialogsContext);
}
