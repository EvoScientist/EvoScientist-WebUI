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
import type { Assistant } from "@langchain/langgraph-sdk";
import { ChatProvider, useChatContext } from "@/providers/ChatProvider";

export type ChatContextValue = ReturnType<typeof useChatContext>;

interface RenderChatOptions {
  activeAssistant?: Assistant | null;
  onHistoryRevalidate?: () => void;
}

export function renderChat(
  opts: RenderChatOptions = {}
): RenderHookResult<ChatContextValue, unknown> {
  const { activeAssistant = null, onHistoryRevalidate } = opts;
  return renderHook(() => useChatContext(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ChatProvider
        activeAssistant={activeAssistant}
        onHistoryRevalidate={onHistoryRevalidate}
      >
        {children}
      </ChatProvider>
    ),
  });
}
