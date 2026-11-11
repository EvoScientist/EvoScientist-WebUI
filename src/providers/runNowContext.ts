"use client";

import { createContext, useContext } from "react";

export interface RunNowValue {
  /** The projects whose AutoSkills run this page follows, by key. */
  running: ReadonlySet<string>;
  /** Start AutoSkills in a project (or follow the run already going there);
   *  nothing while that project's run is followed. */
  run(projectKey: string): Promise<void>;
}

export const RunNowContext = createContext<RunNowValue | null>(null);

/** Run now's state, kept above the views by RunNowProvider. */
export function useRunNowState(): RunNowValue {
  const context = useContext(RunNowContext);
  if (!context) {
    throw new Error("useRunNowState must be used within a RunNowProvider");
  }
  return context;
}
