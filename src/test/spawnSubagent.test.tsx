// @vitest-environment jsdom
//
// Scenario: the assistant runs a tool that requires approval before it
// executes (the HumanInTheLoopMiddleware pattern). The SDK stream pauses
// with an `action_requests` interrupt, the user approves via the ToolApproval
// UI, and the run resumes via `stream.submit(null, {command: {resume: ...}})`.
// This is the shape the backend expects for every human-gated tool call
// (`execute`, `spawn_agent`, `write_file`, ...), so `spawn_agent` is a stand-in.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { toast } from "sonner";
import type { Message, Assistant } from "@langchain/langgraph-sdk";
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { renderChat } from "@/test/renderChat";

const fixtureAssistant: Assistant = {
  assistant_id: "EvoScientist",
  graph_id: "EvoScientist",
  name: "EvoScientist",
  config: {},
  metadata: {},
  version: 1,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T00:00:00Z",
  description: null,
} as Assistant;

const spawnInterrupt = {
  value: {
    action_requests: [
      {
        name: "spawn_agent",
        args: {
          agent: "writing-agent",
          input: "draft the introduction",
        },
      },
    ],
  },
};

describe("spawn-subagent scenario", () => {
  let stream: MockStreamStore;
  let historyRevalidate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
    historyRevalidate = vi.fn();
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("surfaces an action-requests interrupt to the chat context", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      result.current.sendMessage("please draft the intro");
      stream.setLoading(true);
    });
    act(() => {
      // Backend pauses on the spawn_agent tool call, awaiting approval.
      stream.setInterrupt(spawnInterrupt);
      stream.setLoading(false);
    });

    expect(result.current.interrupt).toBeDefined();
    const value = (result.current.interrupt as { value: unknown }).value as {
      action_requests: Array<{ name: string; args: Record<string, unknown> }>;
    };
    expect(value.action_requests).toHaveLength(1);
    expect(value.action_requests[0].name).toBe("spawn_agent");
    expect(value.action_requests[0].args.agent).toBe("writing-agent");
  });

  it("resumeInterrupt submits null values with the resume command and pinned options", () => {
    const { result } = renderChat({
      activeAssistant: fixtureAssistant,
      onHistoryRevalidate: historyRevalidate,
    });
    act(() => {
      result.current.sendMessage("please draft the intro");
      stream.setLoading(true);
      stream.setInterrupt(spawnInterrupt);
      stream.setLoading(false);
    });

    // User clicks Approve on the ToolApprovalInterrupt card. That handler
    // calls `onResume({decisions: [{type: "approve"}]})`, which is the
    // useChatContext.resumeInterrupt path.
    act(() => {
      result.current.resumeInterrupt({ decisions: [{ type: "approve" }] });
    });

    const calls = stream.getSubmitCalls();
    // sendMessage was call [0]; resume is call [1].
    expect(calls).toHaveLength(2);
    const resume = calls[1];
    expect(resume.values).toBeNull();
    const opts = resume.options as {
      command: { resume: { decisions: Array<{ type: string }> } };
      streamSubgraphs: boolean;
      streamMode: string[];
      streamResumable: boolean;
      onDisconnect: string;
      config: { recursion_limit: number };
    };
    expect(opts.command).toEqual({
      resume: { decisions: [{ type: "approve" }] },
    });
    // Same pinned options as sendMessage — the run continues in the same shape.
    expect(opts.streamSubgraphs).toBe(true);
    expect(opts.streamMode).toEqual(["updates"]);
    expect(opts.streamResumable).toBe(true);
    expect(opts.onDisconnect).toBe("continue");
    expect(opts.config.recursion_limit).toBe(100);
  });

  it("propagates a reject decision verbatim through resumeInterrupt", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      stream.setInterrupt(spawnInterrupt);
    });
    act(() => {
      result.current.resumeInterrupt({
        decisions: [{ type: "reject", message: "not now" }],
      });
    });
    const opts = stream.getSubmitCalls()[0].options as {
      command: {
        resume: { decisions: Array<{ type: string; message?: string }> };
      };
    };
    expect(opts.command.resume.decisions[0]).toEqual({
      type: "reject",
      message: "not now",
    });
  });

  it("propagates an edit decision (edited args ride along)", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      stream.setInterrupt(spawnInterrupt);
    });
    act(() => {
      result.current.resumeInterrupt({
        decisions: [
          {
            type: "edit",
            args: { agent: "writing-agent", input: "draft the CONCLUSION" },
          },
        ],
      });
    });
    const opts = stream.getSubmitCalls()[0].options as {
      command: {
        resume: {
          decisions: Array<{ type: string; args?: Record<string, unknown> }>;
        };
      };
    };
    expect(opts.command.resume.decisions[0].type).toBe("edit");
    expect(opts.command.resume.decisions[0].args).toEqual({
      agent: "writing-agent",
      input: "draft the CONCLUSION",
    });
  });

  it("kicks off a thread-list revalidate on resume", () => {
    const { result } = renderChat({
      activeAssistant: fixtureAssistant,
      onHistoryRevalidate: historyRevalidate,
    });
    act(() => {
      stream.setInterrupt(spawnInterrupt);
    });
    // sendMessage was NOT called here; only the resume path fires revalidate.
    expect(historyRevalidate).not.toHaveBeenCalled();
    act(() => {
      result.current.resumeInterrupt({ decisions: [{ type: "approve" }] });
    });
    expect(historyRevalidate).toHaveBeenCalledTimes(1);
  });

  it("clears the interrupt once the SDK stream drops it after resume", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });
    act(() => {
      stream.setInterrupt(spawnInterrupt);
    });
    expect(result.current.interrupt).toBeDefined();

    // User approves; SDK acks the resume by clearing the interrupt as the
    // run continues.
    act(() => {
      result.current.resumeInterrupt({ decisions: [{ type: "approve" }] });
      stream.setLoading(true);
      stream.setInterrupt(undefined);
    });
    expect(result.current.interrupt).toBeUndefined();
  });

  it("completes the round trip: send -> interrupt -> approve -> settled transcript", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    // 1. User asks a question.
    act(() => {
      result.current.sendMessage("please draft the intro");
      stream.setLoading(true);
    });

    // 2. Backend paused at the tool boundary awaiting approval.
    act(() => {
      stream.setInterrupt(spawnInterrupt);
      stream.setLoading(false);
    });
    expect(result.current.interrupt).toBeDefined();

    // 3. User approves via the ToolApproval card.
    act(() => {
      result.current.resumeInterrupt({ decisions: [{ type: "approve" }] });
      stream.setLoading(true);
      stream.setInterrupt(undefined);
    });

    // 4. Sub-agent runs; run settles with the final AI reply.
    const settled: Message[] = [
      { id: "u1", type: "human", content: "please draft the intro" } as Message,
      {
        id: "t1",
        type: "ai",
        content: "",
        tool_calls: [
          {
            id: "call1",
            name: "spawn_agent",
            args: { agent: "writing-agent", input: "draft the introduction" },
          },
        ],
      } as unknown as Message,
      { id: "t1r", type: "tool", content: "draft complete." } as Message,
      { id: "a1", type: "ai", content: "here is the intro" } as Message,
    ];
    act(() => {
      stream.setMessages(settled);
      stream.setLoading(false);
    });

    expect(result.current.messages).toHaveLength(4);
    expect(result.current.interrupt).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
