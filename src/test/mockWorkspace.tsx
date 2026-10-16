// A fixed workspace for tests that mount the chat without a backend. The
// default is a backend without the workspace route, which addresses graphs
// by name as before and checks no folders.

import type { ReactNode } from "react";
import { vi } from "vitest";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/providers/WorkspaceProvider";
import { type WorkspaceState } from "@/lib/workspaceSession";

export function mockWorkspace(
  workspace: WorkspaceState = { status: "legacy" }
): WorkspaceContextValue {
  return {
    workspace,
    refreshing: false,
    error: null,
    isReady: () => workspace.status !== "pending",
    refresh: vi.fn(async () => workspace),
  };
}

/** A backend serving `key`, with every graph the WebUI runs. */
export function readyWorkspace(
  key: string
): Extract<WorkspaceState, { status: "ready" }> {
  return {
    status: "ready",
    key,
    runDir: null,
    local: null,
    graphs: new Set([
      "EvoScientist",
      "scheduler",
      "writing-agent",
      "data-analysis-agent",
      "expert-container-async",
    ]),
  };
}

export function TestWorkspaceProvider({
  value,
  children,
}: {
  value?: WorkspaceContextValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceContext.Provider value={value ?? mockWorkspace()}>
      {children}
    </WorkspaceContext.Provider>
  );
}
