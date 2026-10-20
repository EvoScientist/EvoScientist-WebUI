// @vitest-environment jsdom
//
// The deployment's installed-expert list. Unlike the model registry this is
// deliberately NOT cached at module level — installing or uninstalling a skill
// changes it — so `refresh` has to actually re-request.

import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// The deployment the SDK client talks to; a switch changes it in place.
const deployment = vi.hoisted(() => ({
  value: { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" },
}));

vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => deployment.value,
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
  deployment.value = { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" };
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
    deployment.value = { deploymentUrl: "", apiKey: "" };
    const fetchMock = mockTeams({ teams: [] });
    const { result } = renderHook(() => useTeams());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.teams).toEqual([]);
  });
});

// Settings or the health light's Reconnect swap the deployment without
// remounting the chat, and its experts must follow.
describe("useTeams across a backend switch", () => {
  const A = "http://127.0.0.1:6174";
  const B = "http://127.0.0.1:6200";
  const expertA = { name: "expert-a", description: "On A." };
  const expertB = { name: "expert-b", description: "On B." };

  // Each request waits until the test answers it. `answer` answers the latest
  // request to a deployment; `answerCall` answers one by the order it was
  // sent in, so answers can come back out of order.
  function deferredTeams() {
    const pending: { url: string; resolve: (body: unknown) => void }[] = [];
    const fetchMock = vi.fn(
      (url: string, init?: { headers: Record<string, string> }) =>
        new Promise((resolve) => {
          void init;
          pending.push({
            url,
            resolve: (body) =>
              resolve({ ok: true, json: () => Promise.resolve(body) }),
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const answer = (url: string, teams: unknown[]) =>
      act(async () =>
        pending
          .findLast((p) => p.url === `${url}/api/teams`)
          ?.resolve({ teams })
      );
    const answerCall = (n: number, teams: unknown[]) =>
      act(async () => pending[n]?.resolve({ teams }));
    return { fetchMock, answer, answerCall };
  }

  it("asks the deployment the client talks to, with its key", async () => {
    deployment.value = { deploymentUrl: `${B}/`, apiKey: "secret" };
    const fetchMock = mockTeams({ teams: [] });
    renderHook(() => useTeams());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> }
    ];
    expect(url).toBe(`${B}/api/teams`);
    expect(init.headers["X-Api-Key"]).toBe("secret");
  });

  it("drops the old deployment's experts and reads the new one's", async () => {
    const { answer } = deferredTeams();
    const { result, rerender } = renderHook(() => useTeams());
    await answer(A, [expertA]);
    expect(result.current.teams).toEqual([expertA]);

    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();
    expect(result.current.teams).toEqual([]);
    expect(result.current.loading).toBe(true);

    await answer(B, [expertB]);
    expect(result.current.teams).toEqual([expertB]);
    expect(result.current.loading).toBe(false);
  });

  it("ignores a late answer from the deployment it left", async () => {
    const { answer } = deferredTeams();
    const { result, rerender } = renderHook(() => useTeams());
    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();

    await answer(B, [expertB]);
    await answer(A, [expertA]);
    expect(result.current.teams).toEqual([expertB]);
  });

  // A return is a switch too: the list it had before doesn't show until the
  // deployment answers again.
  it("clears the list when it returns to a deployment", async () => {
    const { answer } = deferredTeams();
    const { result, rerender } = renderHook(() => useTeams());
    await answer(A, [expertA]);
    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();
    deployment.value = { deploymentUrl: A, apiKey: "" };
    rerender();

    expect(result.current.teams).toEqual([]);
    expect(result.current.loading).toBe(true);
    await answer(A, [expertB]);
    expect(result.current.teams).toEqual([expertB]);
  });

  // A new key is a switch too: the list read with the old one may not be
  // what this key may see.
  it("drops the list when only the key changes, and reads with the new key", async () => {
    const { fetchMock, answer } = deferredTeams();
    const { result, rerender } = renderHook(() => useTeams());
    await answer(A, [expertA]);

    deployment.value = { deploymentUrl: A, apiKey: "new-key" };
    rerender();
    expect(result.current.teams).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers["X-Api-Key"]).toBe("new-key");

    await answer(A, [expertB]);
    expect(result.current.teams).toEqual([expertB]);
    expect(result.current.loading).toBe(false);
  });

  it("ignores a late answer to a request sent with the old key", async () => {
    const { answerCall } = deferredTeams();
    const { result, rerender } = renderHook(() => useTeams());
    deployment.value = { deploymentUrl: A, apiKey: "new-key" };
    rerender();

    await answerCall(1, [expertB]);
    await answerCall(0, [expertA]);
    expect(result.current.teams).toEqual([expertB]);
    expect(result.current.loading).toBe(false);
  });

  it("keeps the newer refresh when two come back out of order", async () => {
    const { fetchMock, answerCall } = deferredTeams();
    const { result } = renderHook(() => useTeams());
    await answerCall(0, [expertA]);

    act(() => result.current.refresh());
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await answerCall(2, [expertA, expertB]);
    await answerCall(1, [expertB]);
    expect(result.current.teams).toEqual([expertA, expertB]);
    expect(result.current.loading).toBe(false);
  });

  it("settles on the deployment's list under StrictMode", async () => {
    const { answer } = deferredTeams();
    const { result } = renderHook(() => useTeams(), { wrapper: StrictMode });
    await answer(A, [expertA]);
    expect(result.current.teams).toEqual([expertA]);
    expect(result.current.loading).toBe(false);
  });

  // Only a switch clears: a refresh of the same deployment keeps the list
  // up while it re-reads, so the Experts view doesn't flash empty.
  it("keeps the list while re-reading the same deployment", async () => {
    const { fetchMock, answer } = deferredTeams();
    const { result } = renderHook(() => useTeams());
    await answer(A, [expertA]);

    act(() => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.teams).toEqual([expertA]);
    expect(result.current.loading).toBe(true);

    await answer(A, [expertA, expertB]);
    expect(result.current.teams).toEqual([expertA, expertB]);
    expect(result.current.loading).toBe(false);
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
