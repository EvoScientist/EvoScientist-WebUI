// @vitest-environment jsdom
//
// Whether the backend's main graph takes a /goal request: its input schema
// has `goal_request` (core v0.3.7 and later), asked of the current
// project's chat assistant.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  mockProjects,
  readyProjects,
  TestProjectsProvider,
} from "@/test/mockProjects";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";
import type { ProjectsState } from "@/lib/projects";

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

function render(projects: ProjectsState) {
  const value = mockProjects(projects);
  return renderHook(() => useGoalSupport(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(TestProjectsProvider, { value, children }),
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
    const getSchemas = backendWith(() => Promise.resolve(WITH_GOAL));
    const { result } = render(readyProjects("/ws"));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(true));
    expect(getSchemas).toHaveBeenCalledWith(
      workspaceAssistantId("EvoScientist", "/ws")
    );
  });

  it("is false when the input schema has no goal_request", async () => {
    backendWith(() => Promise.resolve(WITHOUT_GOAL));
    const { result } = render(readyProjects("/ws"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("is false when the backend refuses the question", async () => {
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
    const { result } = render(readyProjects("/ws"));
    await waitFor(() => expect(result.current).toBe(false));
    expect(getSchemas).toHaveBeenCalledTimes(1);
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
    const { result } = render(readyProjects("/ws"));
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
    const { result } = render(readyProjects("/ws"));
    await waitFor(() => expect(result.current).toBe(false), { timeout: 3000 });
    expect(getSchemas).toHaveBeenCalledTimes(2);
  });

  // Only a malformed question is refused for good; a 408 or 429 from a
  // proxy passes.
  it("asks again after a 429", async () => {
    const getSchemas = backendWith(
      vi
        .fn<(id: string) => Promise<unknown>>()
        .mockRejectedValueOnce(
          Object.assign(new Error("HTTP 429"), { status: 429 })
        )
        .mockResolvedValue(WITH_GOAL)
    );
    const { result } = render(readyProjects("/ws"));
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
    const { result } = render(readyProjects("/ws"));
    await waitFor(() => expect(result.current).toBe(true), { timeout: 3000 });
  });

  it("waits for the projects before asking", async () => {
    const getSchemas = backendWith(() => Promise.resolve(WITH_GOAL));
    const { result } = render({ status: "pending" });
    await act(async () => {});
    expect(result.current).toBeUndefined();
    expect(getSchemas).not.toHaveBeenCalled();
  });

  it("asks the new backend after a switch and drops the old one's late answer", async () => {
    const first = deferred<unknown>();
    backendWith(() => first.promise);
    const { result, rerender } = render(readyProjects("/ws"));
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
