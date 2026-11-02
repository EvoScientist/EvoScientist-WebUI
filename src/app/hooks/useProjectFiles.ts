"use client";

import { projectHandle } from "@/lib/projects";
import {
  NO_PROJECT_REASON,
  UNSUPPORTED_CORE_REASON,
} from "@/lib/threadBinding";
import { useProjects } from "@/providers/ProjectsProvider";

/**
 * The current project's files, as this page can reach them: `project`, the
 * handle the file routes take, when they show its folder; otherwise null and
 * the `notice` that says why. `here`: this page shows files at all (a file
 * of another project too).
 */
export function useProjectFiles(): {
  project: string | null;
  notice: string | null;
  here: boolean;
} {
  const { projects, current, files } = useProjects();
  if (projects.status === "unsupported") {
    return { project: null, notice: UNSUPPORTED_CORE_REASON, here: false };
  }
  if (projects.status === "pending" || files === "pending") {
    return { project: null, notice: "Connecting to the backend…", here: false };
  }
  if (files === "elsewhere") {
    return {
      project: null,
      notice:
        "Files show only when this WebUI runs on the backend's machine, with the same EvoScientist data folder.",
      here: false,
    };
  }
  if (!current) return { project: null, notice: NO_PROJECT_REASON, here: true };
  return { project: projectHandle(current.key), notice: null, here: true };
}
