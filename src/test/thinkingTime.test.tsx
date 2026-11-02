// @vitest-environment jsdom
//
// Scenario: the reply to a run started here thinks, then calls a tool. useChat
// times the thinking from the live stream as it happens: nothing has to render
// the reply (a collapsed action group renders nothing until opened). A stream
// joined on load, whose thinking started before the page saw it, has no time.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEffect, useRef, type ReactNode } from "react";
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
import { thoughtSeconds } from "@/lib/thinkingTimer";

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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { renderChat } from "@/test/renderChat";
import { ChatProvider, useChatContext } from "@/providers/ChatProvider";
import { TestProjectsProvider, mockProjects } from "@/test/mockProjects";

const human = { id: "h1", type: "human", content: "List the files" } as Message;
const thinking = (id: string) =>
  ({
    id,
    type: "ai",
    content: [{ type: "thinking", thinking: "I should run ls." }],
  } as unknown as Message);
const answered = (id: string) =>
  ({
    id,
    type: "ai",
    content: [
      { type: "thinking", thinking: "I should run ls." },
      { type: "text", text: "There are no files." },
    ],
  } as unknown as Message);
const callingLs = (id: string) =>
  ({
    ...thinking(id),
    tool_calls: [{ id: "c1", name: "ls", args: {} }],
  } as unknown as Message);

describe("thinking time", () => {
  let stream: MockStreamStore;
  let now: number;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.restoreAllMocks();
  });

  // Streams a reply that thinks for 7 s, then calls a tool.
  const streamReply = (id: string) => {
    act(() => {
      stream.setLoading(true);
      stream.setMessages([human, thinking(id)]);
    });
    now = 7_000;
    act(() => stream.setMessages([human, callingLs(id)]));
  };

  it("times the reply to a message sent here", () => {
    const { result } = renderChat({ connected: true });
    act(() => {
      result.current.sendMessage("List the files");
    });

    streamReply("r1");

    expect(thoughtSeconds("r1")).toBe(7);
  });

  // A short answer and the end of the run can arrive in one update; the
  // transcript useChat hands out lags behind `isLoading` then.
  it("times a reply whose run ends with its answer", () => {
    const { result } = renderChat({ connected: true });
    act(() => {
      result.current.sendMessage("List the files");
    });
    act(() => {
      stream.setLoading(true);
      stream.setMessages([human, thinking("r4")]);
    });
    now = 4_000;
    act(() => {
      stream.setMessages([human, answered("r4")]);
      stream.setLoading(false);
    });

    expect(thoughtSeconds("r4")).toBe(4);
  });

  it("times the reply of a run resumed here", () => {
    const { result } = renderChat({ connected: true });
    act(() => {
      result.current.resumeInterrupt({ decisions: [{ type: "approve" }] });
    });

    streamReply("r2");

    expect(thoughtSeconds("r2")).toBe(7);
  });

  // ChatInterface sends the next queued message from an effect in the commit
  // where the run ends; a child's effects run before useChat's.
  it("times the reply to a message the queue sends as a run ends", () => {
    const { result } = renderHook(
      () => {
        const chat = useChatContext();
        const wasLoading = useRef(chat.isLoading);
        useEffect(() => {
          if (wasLoading.current && !chat.isLoading) chat.sendMessage("Next");
          wasLoading.current = chat.isLoading;
        }, [chat]);
        return chat;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <TestProjectsProvider value={mockProjects()}>
            <ChatProvider>{children}</ChatProvider>
          </TestProjectsProvider>
        ),
      }
    );
    act(() => {
      result.current.sendMessage("List the files");
    });
    streamReply("r5");
    act(() => stream.setLoading(false));
    expect(stream.getSubmitCalls()).toHaveLength(2);

    const next = { id: "h2", type: "human", content: "Next" } as Message;
    act(() => {
      stream.setLoading(true);
      stream.setMessages([human, callingLs("r5"), next, thinking("r6")]);
    });
    now = 12_000;
    act(() =>
      stream.setMessages([human, callingLs("r5"), next, answered("r6")])
    );

    expect(thoughtSeconds("r6")).toBe(5);
  });

  // OpenAI's Responses API streams a reply as its empty first chunk and the
  // rest; the saved reply keeps the first chunk's id.
  it("times a reply split in two under the saved reply's id", () => {
    const head = {
      id: "resp_9",
      type: "ai",
      content: [],
      response_metadata: { id: "resp_9" },
    } as unknown as Message;
    const model = { ls_provider: "openai", ls_model_name: "gpt-6" };
    const { result } = renderChat({ connected: true });
    act(() => {
      result.current.sendMessage("List the files");
    });
    act(() => {
      stream.setMessagesMetadata({ resp_9: model, r9: model });
      stream.setLoading(true);
      stream.setMessages([human, head, thinking("r9")]);
    });
    now = 6_000;
    act(() => stream.setMessages([human, head, answered("r9")]));

    expect(thoughtSeconds("resp_9")).toBe(6);
  });

  it("has no time for a stream joined on load", () => {
    renderChat({ connected: true });

    streamReply("r3");

    expect(thoughtSeconds("r3")).toBeNull();
  });
});
