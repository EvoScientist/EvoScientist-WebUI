// Mount ChatInterface under ChatProvider with mocked peripherals. Child
// components (ChatMessage, ActionGroup, AskUserInterrupt, ...) render as
// no-op stubs that record props for assertion via `getLastProps(name)`.
//
// REQUIRED BOILERPLATE at the top of the test file — the shared mock
// impls live in `@/test/mocks/chatInterfaceStubs`:
//
//   import { vi } from "vitest";
//   import {
//     installMockStreamStore,
//     useMockStreamHook,
//   } from "@/test/mockUseStream";
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
//       ClientProvider: ({ children }: any) => children,
//       useClient: () => getActiveMockClient(),
//     };
//   });
//   vi.mock("nuqs", async () => {
//     const react = await import("react");
//     return { useQueryState: () => react.useState<string | null>(null) };
//   });
//   vi.mock("sonner", () => ({
//     toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
//   }));
//
//   // Peripheral hooks — return default-idle shapes.
//   vi.mock("@/app/hooks/useAsyncAgents", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { useAsyncAgents: m.useAsyncAgentsMock };
//   });
//   vi.mock("@/app/hooks/useAutoNotify", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { useAutoNotify: m.useAutoNotifyMock };
//   });
//   vi.mock("@/app/hooks/useAvailableModels", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { useAvailableModels: m.useAvailableModelsMock };
//   });
//   vi.mock("use-stick-to-bottom", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { useStickToBottom: m.useStickToBottomMock };
//   });
//   vi.mock("@/lib/uiSettings", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { useCollapseAgentActions: m.useCollapseAgentActionsMock };
//   });
//
//   // Child components — render as spy stubs so we can assert prop flow.
//   vi.mock("@/app/components/ChatMessage", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { ChatMessage: m.stubComponent("ChatMessage") };
//   });
//   vi.mock("@/app/components/ActionGroup", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { ActionGroup: m.stubComponent("ActionGroup") };
//   });
//   vi.mock("@/app/components/AskUserInterrupt", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { AskUserInterrupt: m.stubComponent("AskUserInterrupt") };
//   });
//   vi.mock("@/app/components/CompactionSummary", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { CompactionSummary: m.stubComponent("CompactionSummary") };
//   });
//   vi.mock("@/app/components/ResearchDashboard", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { ResearchDashboard: m.stubComponent("ResearchDashboard") };
//   });
//   vi.mock("@/app/components/TasksFilesSidebar", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { FilesPopover: m.stubComponent("FilesPopover") };
//   });
//   vi.mock("@/app/components/WorkspaceFileDialog", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { WorkspaceFileDialog: m.stubComponent("WorkspaceFileDialog") };
//   });
//   vi.mock("@/app/components/MemoryFileDialog", async () => {
//     const m = await import("@/test/mocks/chatInterfaceStubs");
//     return { MemoryFileDialog: m.stubComponent("MemoryFileDialog") };
//   });

import { render, type RenderResult } from "@testing-library/react";
import type { Assistant } from "@langchain/langgraph-sdk";
import { ChatInterface } from "@/app/components/ChatInterface";
import { ChatProvider } from "@/providers/ChatProvider";
import { fixtureAssistant } from "@/test/fixtures/assistants";

interface RenderChatInterfaceOptions {
  assistant?: Assistant | null;
}

export function renderChatInterface(
  opts: RenderChatInterfaceOptions = {}
): RenderResult {
  const assistant = opts.assistant ?? fixtureAssistant;
  return render(
    <ChatProvider activeAssistant={assistant}>
      <ChatInterface assistant={assistant} />
    </ChatProvider>
  );
}
