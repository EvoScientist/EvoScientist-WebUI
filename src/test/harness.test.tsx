// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { Message } from "@langchain/langgraph-sdk";
import {
  MockStreamStore,
  clearMockStreamStore,
  installMockStreamStore,
  useMockStreamHook,
} from "@/test/mockUseStream";
import {
  MockClient,
  clearMockClient,
  getActiveMockClient,
  installMockClient,
} from "@/test/mockClient";

vi.mock("@langchain/langgraph-sdk/react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useStream: useMockStreamHook };
});

vi.mock("@/providers/ClientProvider", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ClientProvider: ({ children }: { children: React.ReactNode }) => children,
    useClient: () => getActiveMockClient(),
  };
});

vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>(null),
  };
});

import { renderChat } from "@/test/renderChat";

describe("chat harness — smoke", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  it("mounts with default state (empty messages, idle, no interrupt)", () => {
    const { result } = renderChat();
    expect(result.current.messages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.interrupt).toBeUndefined();
  });

  it("re-renders when the store pushes new messages", () => {
    const { result } = renderChat();
    act(() => {
      const msgs: Message[] = [
        { id: "u1", type: "human", content: "hi" } as Message,
        { id: "a1", type: "ai", content: "hello" } as Message,
      ];
      stream.setMessages(msgs);
    });
    expect(result.current.messages).toHaveLength(2);
    expect((result.current.messages[1] as { content: unknown }).content).toBe(
      "hello"
    );
  });

  it("re-renders when the store pushes an interrupt", () => {
    const { result } = renderChat();
    act(() => {
      stream.setInterrupt({
        value: { action_requests: [{ name: "execute", args: {} }] },
      });
    });
    expect(result.current.interrupt).toBeDefined();
  });

  it("records a submit call when sendMessage is invoked", () => {
    const { result } = renderChat();
    act(() => {
      result.current.sendMessage("hi");
    });
    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const submitted = calls[0].values as {
      messages: Array<{ content: string }>;
    };
    expect(submitted.messages[0].content).toBe("hi");
  });

  it("records a stop call when stopStream is invoked", () => {
    const { result } = renderChat();
    act(() => {
      result.current.stopStream();
    });
    expect(stream.getStopCallCount()).toBe(1);
  });

  it("throws a helpful error if a test forgot to install the store", () => {
    clearMockStreamStore();
    expect(() => renderChat()).toThrowError(/installMockStreamStore/);
  });
});
