// @vitest-environment jsdom
//
// /goal in useChat: the run's grading marker (configurable.rubric_run), the
// goal_request every run input carries, the goal request run, the mode a
// resume takes, the goal and grading events, and the thread's goal.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
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

// useChat reads one query state ("threadId"); a test sets it before render.
const route = vi.hoisted(() => ({ threadId: null as string | null }));
vi.mock("nuqs", async () => {
  const react = await import("react");
  return {
    useQueryState: () => react.useState<string | null>(route.threadId),
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

const WITH_GOAL = {
  input_schema: { properties: { messages: {}, goal_request: {} } },
};
const REQUEST = {
  kind: "create" as const,
  id: "a".repeat(32),
  objective: "Write hello into probe.txt",
};
const GOAL_VALUES = {
  messages: [],
  _goal: {
    objective: "Write hello into probe.txt",
    status: "active",
    note: null,
    evidence: null,
    rubric_id: "goal:abc",
    start: "m1",
  },
  _sticky_rubric: { text: "- one", id: "goal:abc" },
  _rubric_evaluations: [
    {
      grading_run_id: "g1",
      iteration: 0,
      result: "needs_revision",
      explanation: "Not yet.",
      criteria: [],
    },
  ],
};

type SubmitOptions = {
  config?: { configurable?: Record<string, unknown> };
  command?: unknown;
};

function lastSubmit(stream: MockStreamStore) {
  const calls = stream.getSubmitCalls();
  const call = calls[calls.length - 1];
  return {
    values: call.values as Record<string, unknown> | null,
    options: call.options as SubmitOptions,
  };
}

async function renderWithGoals() {
  getActiveMockClient().assistants.getSchemas.mockResolvedValue(WITH_GOAL);
  const view = renderChat({ connected: true });
  await waitFor(() => expect(view.result.current.goalSupported).toBe(true));
  return view;
}

describe("/goal in useChat", () => {
  let stream: MockStreamStore;

  beforeEach(() => {
    route.threadId = null;
    stream = new MockStreamStore();
    installMockStreamStore(stream);
    installMockClient(new MockClient());
  });

  afterEach(() => {
    clearMockStreamStore();
    clearMockClient();
    vi.clearAllMocks();
  });

  it("marks a message as a thread turn and clears a leftover request", async () => {
    const { result } = await renderWithGoals();
    act(() => {
      result.current.sendMessage("hi");
    });
    const { values, options } = lastSubmit(stream);
    expect(values).toEqual({
      messages: [expect.objectContaining({ type: "human", content: "hi" })],
      goal_request: null,
    });
    expect(options.config?.configurable?.rubric_run).toEqual({
      mode: "thread",
      changes: [],
    });
  });

  it("leaves the run config as it was on a backend without goals", async () => {
    const { result } = renderChat({ connected: true });
    await waitFor(() => expect(result.current.goalSupported).toBe(false));
    act(() => {
      result.current.sendMessage("hi");
    });
    const { values, options } = lastSubmit(stream);
    expect(options.config?.configurable).not.toHaveProperty("rubric_run");
    expect(values).toHaveProperty("goal_request", null);
  });

  it("sends the marker while goal support is still unknown, but no goal request", async () => {
    getActiveMockClient().assistants.getSchemas.mockReturnValue(
      new Promise(() => {})
    );
    const { result } = renderChat({ connected: true });
    expect(result.current.goalSupported).toBeUndefined();
    act(() => {
      result.current.sendMessage("hi");
    });
    expect(lastSubmit(stream).options.config?.configurable?.rubric_run).toEqual(
      {
        mode: "thread",
        changes: [],
      }
    );
    let sent = true;
    act(() => {
      sent = result.current.sendGoalRequest(REQUEST);
    });
    expect(sent).toBe(false);
    expect(stream.getSubmitCalls()).toHaveLength(1);
  });

  it("sends an async report as a followup turn", async () => {
    const { result } = await renderWithGoals();
    act(() => {
      result.current.sendMessage("[Async tasks update]\n{}", {
        mode: "followup",
      });
    });
    expect(lastSubmit(stream).options.config?.configurable?.rubric_run).toEqual(
      {
        mode: "followup",
        changes: [],
      }
    );
  });

  it("sends a goal request as a thread run without a message", async () => {
    const { result } = await renderWithGoals();
    let sent = false;
    act(() => {
      sent = result.current.sendGoalRequest(REQUEST);
    });
    expect(sent).toBe(true);
    const { values, options } = lastSubmit(stream);
    expect(values).toEqual({ messages: [], goal_request: REQUEST });
    expect(options.config?.configurable?.rubric_run).toEqual({
      mode: "thread",
      changes: [],
    });
  });

  it("sends no goal request to a backend without goals", async () => {
    const { result } = renderChat({ connected: true });
    await waitFor(() => expect(result.current.goalSupported).toBe(false));
    let sent = true;
    act(() => {
      sent = result.current.sendGoalRequest(REQUEST);
    });
    expect(sent).toBe(false);
    expect(stream.getSubmitCalls()).toHaveLength(0);
  });

  describe("the mode a resume takes", () => {
    const answer = { status: "answered", answers: ["Accept"] };

    it("is thread after a goal request", async () => {
      const { result } = await renderWithGoals();
      act(() => {
        result.current.sendGoalRequest(REQUEST);
      });
      act(() => {
        result.current.resumeInterrupt(answer);
      });
      const { options } = lastSubmit(stream);
      expect(options.command).toEqual({ resume: answer });
      expect(options.config?.configurable?.rubric_run).toEqual({
        mode: "thread",
        changes: [],
      });
    });

    it("is followup after a followup turn", async () => {
      const { result } = await renderWithGoals();
      act(() => {
        result.current.sendMessage("[Async tasks update]\n{}", {
          mode: "followup",
        });
      });
      act(() => {
        result.current.resumeInterrupt(answer);
      });
      expect(
        lastSubmit(stream).options.config?.configurable?.rubric_run
      ).toEqual({
        mode: "followup",
        changes: [],
      });
    });

    it("resumes with thread when no mode is remembered", async () => {
      const { result } = await renderWithGoals();
      act(() => {
        result.current.resumeInterrupt(answer);
      });
      expect(
        lastSubmit(stream).options.config?.configurable?.rubric_run
      ).toEqual({
        mode: "thread",
        changes: [],
      });
    });
  });

  describe("goal events", () => {
    const accepted = {
      type: "goal_state",
      change: "accepted",
      status: "active",
    };

    it("replayed goal event toasts once", async () => {
      const { result } = await renderWithGoals();
      act(() => {
        result.current.sendGoalRequest(REQUEST);
      });
      act(() => {
        stream.emitCustomEvent(accepted);
        stream.emitCustomEvent(accepted);
      });
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith("Goal accepted.");
      // A new run shows it again.
      act(() => {
        result.current.sendMessage("next");
      });
      act(() => {
        stream.emitCustomEvent(accepted);
      });
      expect(toast.success).toHaveBeenCalledTimes(2);
    });

    it("takes drafting from the drafter's namespace", async () => {
      const { result } = await renderWithGoals();
      act(() => {
        stream.emitCustomEvent({ type: "goal_state", change: "drafting" }, [
          "GoalMiddleware.before_agent:1",
        ]);
      });
      expect(result.current.goalBusy).toBe("drafting");
      act(() => {
        stream.emitCustomEvent(accepted);
      });
      expect(result.current.goalBusy).toBeNull();
    });

    it("shows a grading in progress and its result", async () => {
      const { result } = await renderWithGoals();
      act(() => {
        stream.emitCustomEvent({
          type: "rubric_evaluation_start",
          grading_run_id: "g1",
          iteration: 0,
        });
      });
      expect(result.current.goalBusy).toBe("checking");
      act(() => {
        stream.emitCustomEvent({
          type: "rubric_evaluation_end",
          grading_run_id: "g1",
          iteration: 0,
          result: "needs_revision",
          explanation: "Not yet.",
          criteria: [],
        });
      });
      expect(result.current.goalBusy).toBeNull();
      expect(toast.warning).toHaveBeenCalledWith(
        "Acceptance criteria not yet satisfied: Not yet."
      );
    });
  });

  // A goal request sends no message, so a run the backend refuses hands
  // back the /goal text it was sent for (W02's fold), until the backend has
  // made the run.
  describe("a refused goal request", () => {
    const REQUEST = {
      kind: "create" as const,
      id: "0123456789abcdef0123456789abcdef",
      objective: "write the report",
    };
    const REFUSED = 'HTTP 404: {"detail":"Thread or assistant not found."}';

    it("hands its /goal text back when the run 404s for a missing assistant", async () => {
      const { result } = await renderWithGoals();
      const handBack = vi.fn();
      act(() => {
        result.current.setRefusalHandler(handBack);
      });
      act(() => {
        result.current.sendGoalRequest(REQUEST, "/goal write the report");
      });
      act(() => {
        stream.emitError(new Error(REFUSED));
      });
      expect(handBack).toHaveBeenCalledWith("/goal write the report");
    });

    it("hands back nothing once the backend made the run", async () => {
      const { result } = await renderWithGoals();
      const handBack = vi.fn();
      act(() => {
        result.current.setRefusalHandler(handBack);
      });
      act(() => {
        result.current.sendGoalRequest(REQUEST, "/goal write the report");
      });
      act(() => {
        stream.emitCreated();
      });
      act(() => {
        stream.emitError(new Error(REFUSED));
      });
      expect(handBack).not.toHaveBeenCalled();
    });
  });

  describe("the thread's goal", () => {
    it("is read from the thread's state", async () => {
      route.threadId = "t-1";
      getActiveMockClient().setThreadState("t-1", {
        next: [],
        tasks: [],
        values: GOAL_VALUES,
      });
      const { result } = await renderWithGoals();
      await waitFor(() =>
        expect(result.current.goal).toEqual({
          objective: "Write hello into probe.txt",
          status: "active",
          note: null,
          rubricId: "goal:abc",
          criteria: "- one",
        })
      );
      expect(result.current.rubricVerdict).toEqual({
        result: "needs_revision",
        explanation: "Not yet.",
        iteration: 0,
      });
    });

    it("is read again when a goal event arrives during a run", async () => {
      route.threadId = "t-1";
      const client = getActiveMockClient();
      client.setThreadState("t-1", {
        next: [],
        tasks: [],
        values: { messages: [] },
      });
      const { result } = await renderWithGoals();
      await waitFor(() => expect(client.threads.getState).toHaveBeenCalled());
      expect(result.current.goal).toBeNull();
      act(() => {
        stream.setLoading(true);
      });
      client.setThreadState("t-1", {
        next: ["model"],
        tasks: [],
        values: GOAL_VALUES,
      });
      act(() => {
        stream.emitCustomEvent({
          type: "goal_state",
          change: "accepted",
          status: "active",
        });
      });
      await waitFor(() =>
        expect(result.current.goal?.rubricId).toBe("goal:abc")
      );
    });

    // The run's callbacks come from the render that submitted it, which for
    // a new chat's first run knew no thread yet.
    it("reads the goal a new chat's first run accepts", async () => {
      const client = getActiveMockClient();
      client.setThreadState("t-new", {
        next: ["model"],
        tasks: [],
        values: GOAL_VALUES,
      });
      const { result } = await renderWithGoals();
      act(() => {
        result.current.sendMessage("hi");
      });
      act(() => {
        stream.setLoading(true);
      });
      act(() => {
        (stream.getOptions()?.onThreadId as (id: string) => void)("t-new");
      });
      act(() => {
        stream.emitCustomEventFromSubmit({
          type: "goal_state",
          change: "accepted",
          status: "active",
          unreviewed: true,
        });
      });
      await waitFor(() =>
        expect(result.current.goal?.rubricId).toBe("goal:abc")
      );
    });

    // The SDK doesn't stop a run when its chat unmounts (a thread switch):
    // the run's goal events then belong to a thread no longer shown.
    it("shows no goal toast for a run left behind by a thread switch", async () => {
      const { result, unmount } = await renderWithGoals();
      act(() => {
        result.current.sendMessage("hi");
      });
      unmount();
      stream.emitCustomEventFromSubmit({
        type: "goal_state",
        change: "accepted",
        status: "active",
      });
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("is null for a new chat", async () => {
      const { result } = await renderWithGoals();
      expect(result.current.goal).toBeNull();
    });
  });
});
