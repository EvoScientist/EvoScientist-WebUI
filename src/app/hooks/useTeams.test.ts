// @vitest-environment jsdom
//
// The deployment's installed-expert list. Unlike the model registry this is
// deliberately NOT cached at module level — installing or uninstalling a skill
// changes it — so `refresh` has to actually re-request.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const config = vi.hoisted(() => ({
  value: { deploymentUrl: "http://127.0.0.1:6174", langsmithApiKey: "" } as {
    deploymentUrl: string;
    langsmithApiKey: string;
  } | null,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => config.value,
}));

import { useTeams } from "./useTeams";

function mockTeams(...responses: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn((url: string) => {
    void url;
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  config.value = {
    deploymentUrl: "http://127.0.0.1:6174",
    langsmithApiKey: "",
  };
});

afterEach(() => vi.unstubAllGlobals());

describe("useTeams", () => {
  it("reads the deployment's expert list", async () => {
    const fetchMock = mockTeams({
      teams: [{ name: "paper-review", description: "Adversarial." }],
    });
    const { result } = renderHook(() => useTeams());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teams).toEqual([
      { name: "paper-review", description: "Adversarial." },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/teams");
  });

  it("re-requests on refresh so a fresh install shows up", async () => {
    const fetchMock = mockTeams(
      { teams: [] },
      { teams: [{ name: "paper-review", description: "Just installed." }] }
    );
    const { result } = renderHook(() => useTeams());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teams).toEqual([]);

    act(() => result.current.refresh());

    await waitFor(() =>
      expect(result.current.teams).toEqual([
        { name: "paper-review", description: "Just installed." },
      ])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("survives a deployment that has no such route", async () => {
    // An older backend 404s here. The Experts view still has the local scan,
    // so this must degrade rather than throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        })
      )
    );
    const { result } = renderHook(() => useTeams());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.teams).toEqual([]);
    expect(result.current.error).toContain("404");
  });

  it("does not call out when no deployment is configured", async () => {
    config.value = null;
    const fetchMock = mockTeams({ teams: [] });
    const { result } = renderHook(() => useTeams());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.teams).toEqual([]);
  });
});

describe("useTeams across components", () => {
  it("refreshes every mounted consumer, not just the one that asked", async () => {
    // The Experts view and the chat each hold their own instance, and the
    // chat stays mounted behind the view. Installing a skill there must not
    // leave the composer's pill counting a stale list until a page reload.
    // Both instances mount first (one response each), then the install makes
    // every later response carry the new expert.
    const fetchMock = mockTeams(
      { teams: [] },
      { teams: [] },
      { teams: [{ name: "paper-review", description: "Just installed." }] }
    );
    const viewer = renderHook(() => useTeams());
    const composer = renderHook(() => useTeams());

    await waitFor(() => expect(viewer.result.current.loading).toBe(false));
    await waitFor(() => expect(composer.result.current.loading).toBe(false));
    expect(composer.result.current.teams).toEqual([]);

    // Only one of them triggers the refresh.
    act(() => viewer.result.current.refresh());

    await waitFor(() =>
      expect(composer.result.current.teams).toEqual([
        { name: "paper-review", description: "Just installed." },
      ])
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
