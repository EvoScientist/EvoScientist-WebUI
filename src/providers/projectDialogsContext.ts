"use client";

import { createContext, useContext } from "react";
import type { Project } from "@/lib/projects";

export interface ProjectDialogsValue {
  /** Ask for a folder to add as a project; `folder` fills the field. */
  openAddProject: (folder?: string) => void;
  /** Confirm removing `project`. */
  openRemoveProject: (project: Project) => void;
  /** Ask for the folder `project` (one whose folder is missing) was moved
   *  to; absent when this page can't move projects. */
  openMoveProject?: (project: Project) => void;
  /** The keys of the projects being moved: none is offered another move
   *  until its move ends. */
  moving?: ReadonlySet<string>;
}

/** Outside a provider there is nowhere to show the dialogs: the actions do
 *  nothing, and no move is offered. */
const NO_DIALOGS: ProjectDialogsValue = {
  openAddProject: () => {},
  openRemoveProject: () => {},
};

export const ProjectDialogsContext =
  createContext<ProjectDialogsValue>(NO_DIALOGS);

export function useProjectDialogs(): ProjectDialogsValue {
  return useContext(ProjectDialogsContext);
}
