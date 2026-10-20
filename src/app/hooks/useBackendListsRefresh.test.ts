// @vitest-environment jsdom
//
// The model registry and the expert list are read again when the backend may
// have changed under the same URL: the health light saw it come back, or the
// tab comes back into view (a hidden tab isn't probed).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAvailableModels } from "./useAvailableModels";
import { useTeams } from "./useTeams";
import {
  refreshBackendLists,
  useBackendListsRefresh,
} from "./useBackendListsRefresh";

const deployment = vi.hoisted(() => ({
  value: { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" },
}));

vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => deployment.value,
}));

// The registry cache lives for the page, so each test uses an address of its
// own.
let port = 7500;
let A = "";
beforeEach(() => {
  A = `http://127.0.0.1:${port++}`;
  deployment.value = { deploymentUrl: A, apiKey: "" };
});

// Every answer names how many times its route was asked, so a re-read shows.
function countingBackend() {
  const calls = { models: 0, teams: 0 };
  const fetchMock = vi.fn((url: string) => {
    const path = new URL(url).pathname;
    const body =
      path === "/api/models"
        ? {
            entries: [{ name: `model-${++calls.models}`, provider: "openai" }],
            default: { name: `model-${calls.models}`, provider: "openai" },
          }
        : {
            teams: [{ name: `expert-${++calls.teams}`, description: "x" }],
          };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function renderLists() {
  return renderHook(() => ({
    models: useAvailableModels(),
    teams: useTeams(),
  }));
}

let visibility: DocumentVisibilityState = "visible";
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.unstubAllGlobals();
});

describe("refreshBackendLists", () => {
  it("reads the models and the experts again", async () => {
    const calls = countingBackend();
    const { result } = renderLists();
    await waitFor(() =>
      expect(result.current.teams.teams[0]?.name).toBe("expert-1")
    );
    expect(result.current.models.registry.defaultEntry?.name).toBe("model-1");

    act(() => refreshBackendLists(A));
    await waitFor(() =>
      expect(result.current.teams.teams[0]?.name).toBe("expert-2")
    );
    expect(result.current.models.registry.defaultEntry?.name).toBe("model-2");
    expect(calls).toEqual({ models: 2, teams: 2 });
  });
});

describe("useBackendListsRefresh", () => {
  it("reads both lists again when the tab comes back into view", async () => {
    const calls = countingBackend();
    renderHook(() => useBackendListsRefresh(A));
    const { result } = renderLists();
    await waitFor(() => expect(calls).toEqual({ models: 1, teams: 1 }));

    setVisibility("hidden");
    await act(async () => {});
    expect(calls).toEqual({ models: 1, teams: 1 });

    setVisibility("visible");
    await waitFor(() =>
      expect(result.current.models.registry.defaultEntry?.name).toBe("model-2")
    );
    expect(result.current.teams.teams[0]?.name).toBe("expert-2");
    expect(calls).toEqual({ models: 2, teams: 2 });
  });

  it("stops listening once unmounted", async () => {
    const calls = countingBackend();
    const refresher = renderHook(() => useBackendListsRefresh(A));
    renderLists();
    await waitFor(() => expect(calls).toEqual({ models: 1, teams: 1 }));

    refresher.unmount();
    setVisibility("hidden");
    setVisibility("visible");
    await act(async () => {});
    expect(calls).toEqual({ models: 1, teams: 1 });
  });

  it("reads the deployment it is given now", async () => {
    const calls = countingBackend();
    const refresher = renderHook(({ url }) => useBackendListsRefresh(url), {
      initialProps: { url: "http://127.0.0.1:1" },
    });
    const { result } = renderLists();
    await waitFor(() => expect(calls).toEqual({ models: 1, teams: 1 }));

    refresher.rerender({ url: A });
    setVisibility("hidden");
    setVisibility("visible");
    await waitFor(() =>
      expect(result.current.models.registry.defaultEntry?.name).toBe("model-2")
    );
  });
});
