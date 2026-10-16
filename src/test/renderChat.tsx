// Mount a ChatProvider under the active mock stream + mock client and return
// react-testing-library's `renderHook` result. `result.current` is the value
// exposed by `useChatContext` — the same object ChatInterface reads.
//
// Boilerplate required at module top-level of every test file that calls
// `renderChat` (vitest hoisting demands these live in the test file itself):
//
//   import { vi } from "vitest";
//   import { useMockStreamHook } from "@/test/mockUseStream";
//   import { getActiveMockClient } from "@/test/mockClient";
//
//   vi.mock("@langchain/langgraph-sdk/react", async (importOriginal) => {
//     const actual = await importOriginal<any>();
//     return { ...actual, useStream: useMockStreamHook };
//   });
//   vi.mock("@/providers/ClientProvider", async (importOriginal) => {
//     const actual = await importOriginal<any>();
//     return {
//       ...actual,
//       ClientProvider: ({ children }: { children: React.ReactNode }) =>
//         children,
//       useClient: () => getActiveMockClient(),
//     };
//   });
//   vi.mock("nuqs", async () => {
//     const react = await import("react");
//     return {
//       useQueryState: () => react.useState<string | null>(null),
//     };
//   });

import { renderHook, type RenderHookResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatProvider, useChatContext } from "@/providers/ChatProvider";
import type { ThreadUnavailableInfo } from "@/app/hooks/useChat";
import type { WorkspaceContextValue } from "@/providers/WorkspaceProvider";
import { TestWorkspaceProvider, mockWorkspace } from "@/test/mockWorkspace";

export type ChatContextValue = ReturnType<typeof useChatContext>;

interface RenderChatOptions {
  /** A backend without the workspace route that the chat can run on; false
   *  (the default) leaves the backend's folder unknown, so nothing runs. */
  connected?: boolean;
  onHistoryRevalidate?: () => void;
  onThreadUnavailable?: (info: ThreadUnavailableInfo) => void;
  /** The backend's folder; defaults to a backend without the route. */
  workspace?: WorkspaceContextValue;
}

export function renderChat(
  opts: RenderChatOptions = {}
): RenderHookResult<ChatContextValue, unknown> {
  const {
    connected = false,
    onHistoryRevalidate,
    onThreadUnavailable,
    workspace,
  } = opts;
  return renderHook(() => useChatContext(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TestWorkspaceProvider
        value={
          workspace ??
          mockWorkspace(connected ? undefined : { status: "pending" })
        }
      >
        <ChatProvider
          onHistoryRevalidate={onHistoryRevalidate}
          onThreadUnavailable={onThreadUnavailable}
        >
          {children}
        </ChatProvider>
      </TestWorkspaceProvider>
    ),
  });
}
