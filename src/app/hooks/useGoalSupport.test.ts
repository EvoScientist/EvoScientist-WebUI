// @vitest-environment jsdom
//
// Whether the backend's main graph takes a /goal request: its input schema
// has `goal_request` (core v0.3.7 and later), or, when the input schema is
// missing or empty (a Python 3.11 core can't build it), its state schema has
// it.
// getSchemas takes only an assistant UUID; a legacy core's graph name gets a
// 422, and such a core has no goal either.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  mockWorkspace,
  readyWorkspace,
  TestWorkspaceProvider,
} from "@/test/mockWorkspace";
import { assistantIdFor, type WorkspaceState } from "@/lib/workspaceSession";

// The SDK client: one per deployment, so a switch hands the hook a new one.
const backend = vi.hoisted(() => ({
  client: {
    assistants: {
      getSchemas: (() => Promise.resolve({})) as (
        id: string
      ) => Promise<unknown>,
    },
  },
}));
vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => backend.client,
}));

import { useGoalSupport } from "./useGoalSupport";

const WITH_GOAL = {
  input_schema: { properties: { messages: {}, goal_request: {} } },
};
const WITHOUT_GOAL = { input_schema: { properties: { messages: {} } } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function render(workspace: WorkspaceState) {
  const value = mockWorkspace(workspace);
  return renderHook(() => useGoalSupport(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(TestWorkspaceProvider, { value, children }),
  });
}

function backendWith(getSchemas: (id: string) => Promise<unknown>) {
  const spy = vi.fn(getSchemas);
  backend.client = { assistants: { getSchemas: spy } };
  return spy;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useGoalSupport", () => {
  it("is true when the main graph takes goal_request", async () => {
    const workspace = readyWorkspace("/ws");
    const getSchemas = backendWith(() => Promise.resolve(WITH_GOAL));
    const { result } = render(workspace);
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
    expect(getSchemas).toHaveBeenCalledWith(
      assistantIdFor(workspace, "EvoScientist")
    );
  });

  it("is false when the input schema has no goal_request", async () => {
    backendWith(() => Promise.resolve(WITHOUT_GOAL));
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  // A core on Python 3.11 can't build its input schema (pydantic refuses
  // typing.TypedDict there): langgraph-api answers it, and the output schema,
  // null. Its state schema still lists goal_request, which is in the input
  // whenever it is in the state.
  it("is true when the input schema is null and the state has goal_request", async () => {
    backendWith(() =>
      Promise.resolve({
        input_schema: null,
        output_schema: null,
        state_schema: { properties: { messages: {}, goal_request: {} } },
      })
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("falls back to the state when the input schema has no fields", async () => {
    backendWith(() =>
      Promise.resolve({
        input_schema: { type: "object", properties: {} },
        state_schema: { properties: { messages: {}, goal_request: {} } },
      })
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("falls back to the state when the input's properties are an array", async () => {
    backendWith(() =>
      Promise.resolve({
        input_schema: { properties: ["messages"] },
        state_schema: { properties: { messages: {}, goal_request: {} } },
      })
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is false when the input schema is null and the state has no goal_request", async () => {
    backendWith(() =>
      Promise.resolve({
        input_schema: null,
        state_schema: { properties: { messages: {} } },
      })
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("decides from the input schema when it has fields", async () => {
    backendWith(() =>
      Promise.resolve({
        input_schema: { properties: { messages: {} } },
        state_schema: { properties: { messages: {}, goal_request: {} } },
      })
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is true when there is no input schema and the state has goal_request", async () => {
    backendWith(() =>
      Promise.resolve({
        state_schema: { properties: { messages: {}, goal_request: {} } },
      })
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is false when the backend refuses, as a legacy core does a graph name", async () => {
    const getSchemas = backendWith(() =>
      Promise.reject(
        Object.assign(
          new Error(
            'HTTP 422: {"detail":"Invalid assistant ID: must be a UUID"}'
          ),
          { status: 422 }
        )
      )
    );
    const { result } = render({ status: "legacy" });
    await waitFor(() => expect(result.current).toBe(false));
    expect(getSchemas).toHaveBeenCalledWith("EvoScientist");
  });

  // Only a refusal is an answer. A failed request (no answer, 5xx) leaves
  // support unknown, which still marks every run, and is asked again: a
  // review reloaded during a blip must keep its marker.
  it("stays unknown after a request without an answer and asks again", async () => {
    const getSchemas = backendWith(
      vi
        .fn<(id: string) => Promise<unknown>>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue(WITH_GOAL)
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(getSchemas).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true), { timeout: 3000 });
    expect(getSchemas).toHaveBeenCalledTimes(2);
  });

  it("asks again after a server error", async () => {
    const getSchemas = backendWith(
      vi
        .fn<(id: string) => Promise<unknown>>()
        .mockRejectedValueOnce(
          Object.assign(new Error("HTTP 503"), { status: 503 })
        )
        .mockResolvedValue(WITHOUT_GOAL)
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(false), { timeout: 3000 });
    expect(getSchemas).toHaveBeenCalledTimes(2);
  });

  // Only a malformed question is refused for good (a legacy core answers a
  // graph name with 422); a 408 or 429 from a proxy passes.
  it("asks again after a 429", async () => {
    const getSchemas = backendWith(
      vi
        .fn<(id: string) => Promise<unknown>>()
        .mockRejectedValueOnce(
          Object.assign(new Error("HTTP 429"), { status: 429 })
        )
        .mockResolvedValue(WITH_GOAL)
    );
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(true), { timeout: 3000 });
    expect(getSchemas).toHaveBeenCalledTimes(2);
  });

  it("survives a client that throws before it can ask", async () => {
    let calls = 0;
    backend.client = {
      assistants: {
        getSchemas: () => {
          calls += 1;
          if (calls === 1) throw new TypeError("not ready");
          return Promise.resolve(WITH_GOAL);
        },
      },
    };
    const { result } = render(readyWorkspace("/ws"));
    await waitFor(() => expect(result.current).toBe(true), { timeout: 3000 });
  });

  it("waits for the backend's folder before asking", async () => {
    const getSchemas = backendWith(() => Promise.resolve(WITH_GOAL));
    const { result } = render({ status: "pending" } as WorkspaceState);
    await act(async () => {});
    expect(result.current).toBeUndefined();
    expect(getSchemas).not.toHaveBeenCalled();
  });

  it("asks the new backend after a switch and drops the old one's late answer", async () => {
    const first = deferred<unknown>();
    backendWith(() => first.promise);
    const { result, rerender } = render(readyWorkspace("/ws"));
    expect(result.current).toBeUndefined();

    backendWith(() => Promise.resolve(WITHOUT_GOAL));
    rerender();
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));

    await act(async () => {
      first.resolve(WITH_GOAL);
    });
    expect(result.current).toBe(false);
  });
});
