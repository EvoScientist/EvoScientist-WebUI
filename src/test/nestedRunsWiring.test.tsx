// @vitest-environment jsdom
//
// The client useChat hands to useStream skips the events of a middleware's
// nested run (goal drafter, rubric grader), which the SDK would otherwise
// take for the chat's values (probe P5, 2026-10-24).

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
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

async function* emit(names: string[]) {
  for (const event of names) yield { event, data: {} };
}

describe("the stream client", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    const client = new MockClient();
    Object.assign(client, {
      runs: {
        stream: vi.fn(() =>
          emit(["values", "values|GoalMiddleware.before_agent:1"])
        ),
        joinStream: vi.fn(() =>
          emit(["values", "values|EvoRubricMiddleware.after_agent:1"])
        ),
      },
    });
    installMockClient(client);
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
  });

  it("skips nested runs' events on stream and joinStream", async () => {
    renderChat({ connected: true });
    const client = stream.getOptions()?.client as {
      runs: {
        stream: (...args: unknown[]) => AsyncIterable<{ event: string }>;
        joinStream: (...args: unknown[]) => AsyncIterable<{ event: string }>;
      };
    };
    const seen: string[] = [];
    for await (const chunk of client.runs.stream("t1", "a1", {})) {
      seen.push(chunk.event);
    }
    for await (const chunk of client.runs.joinStream("t1", "r1", {})) {
      seen.push(chunk.event);
    }
    expect(seen).toEqual(["values", "values"]);
  });
});
