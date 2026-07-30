// @vitest-environment jsdom
//
// Scenario: user summons an expert team, then submits a message. The outgoing
// stream.submit config must carry `configurable.active_teams: [<team-name>]`
// so the backend's ActiveTeamMiddleware picks it up on the run. Dismissing
// the team drops the key entirely on subsequent submits.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { toast } from "sonner";
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

import { renderChat } from "@/test/renderChat";
import { fixtureAssistantWithConfig as fixtureAssistant } from "@/test/fixtures/assistants";

describe("configurable.active_teams wiring", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.mocked(toast.error).mockClear();
  });

  it("sends configurable.active_teams when a team is summoned", async () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    await act(async () => {
      await result.current.setActiveTeams(["idea-brainstorm"]);
    });

    act(() => {
      result.current.sendMessage("brainstorm please");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const opts = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    expect(opts.config.configurable.active_teams).toEqual(["idea-brainstorm"]);
    // Assistant-level configurable is preserved alongside.
    expect(opts.config.configurable.some_seed).toBe("abc");
  });

  it("omits active_teams when no team is summoned", () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    act(() => {
      result.current.sendMessage("hi");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(1);
    const opts = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    expect(opts.config.configurable.active_teams).toBeUndefined();
  });

  it("drops active_teams on next submit after Dismiss", async () => {
    const { result } = renderChat({ activeAssistant: fixtureAssistant });

    await act(async () => {
      await result.current.setActiveTeams(["idea-brainstorm"]);
    });
    act(() => {
      result.current.sendMessage("first");
    });
    await act(async () => {
      await result.current.setActiveTeams([]);
    });
    act(() => {
      result.current.sendMessage("second");
    });

    const calls = stream.getSubmitCalls();
    expect(calls).toHaveLength(2);
    const first = calls[0].options as {
      config: { configurable: Record<string, unknown> };
    };
    const second = calls[1].options as {
      config: { configurable: Record<string, unknown> };
    };
    expect(first.config.configurable.active_teams).toEqual(["idea-brainstorm"]);
    expect(second.config.configurable.active_teams).toBeUndefined();
  });
});
