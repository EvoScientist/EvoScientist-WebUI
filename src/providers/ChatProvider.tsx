"use client";

import { ReactNode, createContext, useContext } from "react";
import {
  type StateType,
  type ThreadUnavailableInfo,
  useChat,
} from "@/app/hooks/useChat";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";
import type { ModelRegistry } from "@/app/hooks/useAvailableModels";

interface ChatProviderProps {
  children: ReactNode;
  defaultModel?: ModelRegistry["defaultEntry"];
  onHistoryRevalidate?: () => void;
  onThreadUnavailable?: (
    info: ThreadUnavailableInfo
  ) => boolean | void | { unsentBack: boolean };
  thread?: UseStreamThread<StateType>;
}

export function ChatProvider({
  children,
  defaultModel,
  onHistoryRevalidate,
  onThreadUnavailable,
  thread,
}: ChatProviderProps) {
  const chat = useChat({
    defaultModel,
    onHistoryRevalidate,
    onThreadUnavailable,
    thread,
  });
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export type ChatContextType = ReturnType<typeof useChat>;

export const ChatContext = createContext<ChatContextType | undefined>(
  undefined
);

export function useChatContext() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}
