"use client";

import { useMemo, type ReactNode } from "react";
import { useRunNow } from "@/app/hooks/useRunNow";
import type { Project } from "@/lib/projects";
import { useProjects } from "@/providers/ProjectsProvider";
import { RunNowContext } from "@/providers/runNowContext";

const NO_PROJECTS: readonly Project[] = [];

/**
 * Run now's runs, above the views: a run takes minutes, and leaving the
 * drafts page (another view, the breadcrumb, a "Where it came from" link)
 * must neither stop following it nor let the same project start twice. A
 * deployment switch still drops the runs in flight (useRunNow's rule).
 */
export function RunNowProvider({ children }: { children: ReactNode }) {
  const { projects } = useProjects();
  const list = projects.status === "ready" ? projects.projects : NO_PROJECTS;
  const { running, run } = useRunNow(list);
  const value = useMemo(() => ({ running, run }), [running, run]);
  return (
    <RunNowContext.Provider value={value}>{children}</RunNowContext.Provider>
  );
}
