// @vitest-environment jsdom
//
// The deployment's model registry. It is cached per deployment URL and key
// until a refresh drops it, so a switch reads the new deployment once and a
// return to one already read reuses it.

import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { refreshModelRegistry, useAvailableModels } from "./useAvailableModels";

// The deployment the SDK client talks to; a switch changes it in place.
const deployment = vi.hoisted(() => ({
  value: { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" },
}));

vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => deployment.value,
}));

const registry = (name: string) => ({
  entries: [{ name, model_id: name, provider: "openai" }],
  default: { name, provider: "openai" },
});

// The registry cache lives for the page, so each test uses addresses of its
// own.
let port = 7000;
let A = "";
let B = "";
beforeEach(() => {
  A = `http://127.0.0.1:${port++}`;
  B = `http://127.0.0.1:${port++}`;
  deployment.value = { deploymentUrl: A, apiKey: "" };
});

afterEach(() => vi.unstubAllGlobals());

// Each request waits until the test answers it. `answer` and `fail` answer the
// latest request to a deployment (`fail` with an error status); `answerCall`
// and `failCall` answer one by the order it was sent in, so answers can come
// back out of order.
function deferredRegistry() {
  const pending: {
    url: string;
    resolve: (body: unknown, status?: number) => void;
  }[] = [];
  const fetchMock = vi.fn(
    (url: string, init?: { headers: Record<string, string> }) =>
      new Promise((resolve) => {
        void init;
        pending.push({
          url,
          resolve: (body, status = 200) =>
            resolve({
              ok: status < 400,
              status,
              json: () => Promise.resolve(body),
            }),
        });
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  const latest = (url: string) =>
    pending.findLast((p) => p.url === `${url}/api/models`);
  const answer = (url: string, body: unknown) =>
    act(async () => latest(url)?.resolve(body));
  const fail = (url: string, status: number) =>
    act(async () => latest(url)?.resolve({}, status));
  const answerCall = (n: number, body: unknown) =>
    act(async () => pending[n]?.resolve(body));
  const failCall = (n: number, status: number) =>
    act(async () => pending[n]?.resolve({}, status));
  return { fetchMock, answer, fail, answerCall, failCall };
}

describe("useAvailableModels", () => {
  it("asks the deployment the client talks to, with its key", async () => {
    deployment.value = { deploymentUrl: `${B}/`, apiKey: "secret" };
    const { fetchMock, answer } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());
    await answer(B, registry("model-b"));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> }
    ];
    expect(url).toBe(`${B}/api/models`);
    expect(init.headers["X-Api-Key"]).toBe("secret");
    expect(result.current.registry.entries.map((e) => e.name)).toEqual([
      "model-b",
    ]);
  });

  // Settings or the health light's Reconnect swap the deployment without
  // remounting the chat.
  it("drops the old deployment's models and reads the new one's", async () => {
    const { answer } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");

    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();
    expect(result.current.registry.entries).toEqual([]);
    expect(result.current.registry.defaultEntry).toBeNull();
    expect(result.current.loading).toBe(true);

    await answer(B, registry("model-b"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-b");
    expect(result.current.loading).toBe(false);
  });

  it("ignores a late answer from the deployment it left", async () => {
    const { answer } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();

    await answer(B, registry("model-b"));
    await answer(A, registry("model-a"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-b");
  });

  it("reuses the registry of a deployment it returns to", async () => {
    const { fetchMock, answer } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));
    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();
    await answer(B, registry("model-b"));

    deployment.value = { deploymentUrl: A, apiKey: "" };
    rerender();
    await waitFor(() =>
      expect(result.current.registry.defaultEntry?.name).toBe("model-a")
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A return is a switch too: what the deployment said before doesn't show
  // until it answers again.
  it("clears the registry when it returns to a deployment", async () => {
    const { answer } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));
    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();
    deployment.value = { deploymentUrl: A, apiKey: "" };
    rerender();

    expect(result.current.registry.entries).toEqual([]);
    expect(result.current.loading).toBe(true);
    await waitFor(() =>
      expect(result.current.registry.defaultEntry?.name).toBe("model-a")
    );
  });

  // A new key is a switch too: what the old key read may not be what this
  // key may see.
  it("drops the models when only the key changes, and reads with the new key", async () => {
    const { fetchMock, answer } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));

    deployment.value = { deploymentUrl: A, apiKey: "new-key" };
    rerender();
    expect(result.current.registry.entries).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers["X-Api-Key"]).toBe("new-key");

    await answer(A, registry("model-b"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-b");
    expect(result.current.loading).toBe(false);
  });

  it("ignores a late answer to a request sent with the old key", async () => {
    const { answerCall } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    deployment.value = { deploymentUrl: A, apiKey: "new-key" };
    rerender();

    await answerCall(1, registry("model-b"));
    await answerCall(0, registry("model-a"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-b");
    expect(result.current.loading).toBe(false);
  });

  it("reports a failed read, shows no models, and tries again later", async () => {
    const { fetchMock, answer, fail } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    await fail(A, 500);
    expect(result.current.error).toContain("500");
    expect(result.current.registry.entries).toEqual([]);
    expect(result.current.loading).toBe(false);

    deployment.value = { deploymentUrl: B, apiKey: "" };
    rerender();
    await answer(B, registry("model-b"));
    deployment.value = { deploymentUrl: A, apiKey: "" };
    rerender();
    await answer(A, registry("model-a"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");
  });

  it("settles on the deployment's registry under StrictMode", async () => {
    const { answer } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels(), {
      wrapper: StrictMode,
    });
    await answer(A, registry("model-a"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");
    expect(result.current.loading).toBe(false);
  });

  it("does not call out when no deployment is configured", async () => {
    deployment.value = { deploymentUrl: "", apiKey: "" };
    const { fetchMock } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// refreshModelRegistry runs when the backend may have changed under the same
// URL: it may have restarted with other models, or not have been up when the
// page loaded.
describe("useAvailableModels after the backend comes back", () => {
  it("reads again and keeps the registry up meanwhile", async () => {
    const { fetchMock, answer } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));

    act(() => refreshModelRegistry(`${A}/`));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");
    expect(result.current.loading).toBe(false);

    await answer(A, registry("model-b"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-b");
    expect(result.current.loading).toBe(false);
  });

  it("recovers from a read that failed while the backend was down", async () => {
    const { answer, fail } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());
    await fail(A, 502);
    expect(result.current.error).toContain("502");

    act(() => refreshModelRegistry(A));
    await answer(A, registry("model-a"));
    expect(result.current.error).toBeNull();
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");
  });

  it("drops what the address said under every key", async () => {
    const { fetchMock, answer } = deferredRegistry();
    const { result, rerender } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));
    deployment.value = { deploymentUrl: A, apiKey: "other-key" };
    rerender();
    await answer(A, registry("model-a"));

    act(() => refreshModelRegistry(A));
    await answer(A, registry("model-b"));
    deployment.value = { deploymentUrl: A, apiKey: "" };
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await answer(A, registry("model-b"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-b");
  });

  it("leaves the shown registry alone when another address is refreshed", async () => {
    const { fetchMock, answer } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));

    await act(async () => refreshModelRegistry(B));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");
  });

  // `http://host:7000` is not `http://host:70000`.
  it("leaves an address that only starts the same alone", async () => {
    deployment.value = { deploymentUrl: `${A}0`, apiKey: "" };
    const { fetchMock, answer } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());
    await answer(`${A}0`, registry("model-a"));

    await act(async () => refreshModelRegistry(A));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.registry.defaultEntry?.name).toBe("model-a");
  });

  it("keeps the newer answer when two refreshes come back out of order", async () => {
    const { answerCall } = deferredRegistry();
    const { result } = renderHook(() => useAvailableModels());
    await answerCall(0, registry("model-a"));

    act(() => refreshModelRegistry(A));
    act(() => refreshModelRegistry(A));
    await answerCall(2, registry("model-c"));
    await answerCall(1, registry("model-b"));
    expect(result.current.registry.defaultEntry?.name).toBe("model-c");
  });

  // A refresh drops a request still in flight; that request failing later
  // must not take the newer one out of the cache.
  it("keeps the newer request cached when a dropped one fails", async () => {
    const { fetchMock, answerCall, failCall } = deferredRegistry();
    renderHook(() => useAvailableModels());
    act(() => refreshModelRegistry(A));
    await answerCall(1, registry("model-b"));
    await failCall(0, 502);

    const later = renderHook(() => useAvailableModels());
    await waitFor(() =>
      expect(later.result.current.registry.defaultEntry?.name).toBe("model-b")
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends one request for all mounted readers", async () => {
    const { fetchMock, answer } = deferredRegistry();
    const first = renderHook(() => useAvailableModels());
    const second = renderHook(() => useAvailableModels());
    await answer(A, registry("model-a"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => refreshModelRegistry(A));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await answer(A, registry("model-b"));
    expect(first.result.current.registry.defaultEntry?.name).toBe("model-b");
    expect(second.result.current.registry.defaultEntry?.name).toBe("model-b");
  });
});
