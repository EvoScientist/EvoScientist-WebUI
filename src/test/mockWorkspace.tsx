// A fixed workspace for tests that mount the chat without a backend. The
// default is a backend without the workspace route, which addresses graphs
// as before and checks no folders.

import type { ReactNode } from "react";
import { vi } from "vitest";
import type { Assistant } from "@langchain/langgraph-sdk";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
  type WorkspaceState,
} from "@/providers/WorkspaceProvider";
import { fixtureAssistant } from "@/test/fixtures/assistants";

export function mockWorkspace(
  workspace: WorkspaceState = { status: "legacy" },
  /** The chat graph's assistant; null while it is not resolved. */
  chatAssistant: Assistant | null = fixtureAssistant
): WorkspaceContextValue {
  return {
    workspace,
    refreshing: false,
    isReady: () => workspace.status !== "pending",
    chat: { assistant: chatAssistant, error: null },
    assistantFor: vi.fn(
      async (graphId: string): Promise<Assistant> => ({
        ...fixtureAssistant,
        assistant_id: `${graphId}-assistant`,
        graph_id: graphId,
      })
    ),
    refresh: vi.fn(async () => workspace),
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
