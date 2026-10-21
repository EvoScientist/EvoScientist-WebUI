// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useSettings, useSettingsAccess } from "@/app/hooks/useSettings";

const deployment = { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" };
vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => deployment,
}));

const INSTANCE = "0123456789abcdef";
const payload = (extra: Record<string, unknown> = {}) => ({
  settings: { provider: "openai" },
  sources: {},
  read_only: [],
  providers: {},
  setup_needed: true,
  restart_required: false,
  restart_fields: [],
  revision: "rev-1",
  config_error: null,
  instance: INSTANCE,
  ...extra,
});
const access = (extra: Record<string, unknown> = {}) => ({
  writable: true,
  port: 6174,
  instance: INSTANCE,
  revision: "rev-1",
  ...extra,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

// A fresh SWR cache per test, no deduping between renders.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

function stubFetch(
  answers: Record<string, () => Response | Promise<Response>>
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const path = url.startsWith("/") ? url : new URL(url).pathname;
      const answer = answers[path];
      if (!answer) throw new Error(`unexpected fetch ${url}`);
      return answer();
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useSettings", () => {
  beforeEach(() => {
    deployment.deploymentUrl = "http://127.0.0.1:6174";
    deployment.apiKey = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the deployment's settings", async () => {
    const fetchMock = stubFetch({ "/api/settings": () => json(payload()) });
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.payload).toBeDefined());
    expect(result.current.payload?.setup_needed).toBe(true);
    expect(result.current.unsupported).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6174/api/settings"
    );
  });

  it("sends the API key when there is one", async () => {
    deployment.apiKey = "k-1";
    const fetchMock = stubFetch({ "/api/settings": () => json(payload()) });
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.payload).toBeDefined());
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toEqual({ "X-Api-Key": "k-1" });
  });

  it.each([404, 405])(
    "treats %i as a backend without settings",
    async (status) => {
      stubFetch({ "/api/settings": () => json({}, status) });
      const { result } = renderHook(() => useSettings(), { wrapper });
      await waitFor(() => expect(result.current.unsupported).toBe(true));
      expect(result.current.payload).toBeUndefined();
      expect(result.current.error).toBeUndefined();
    }
  );

  it("reports other failures as errors", async () => {
    stubFetch({ "/api/settings": () => json({ error: "x" }, 500) });
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.unsupported).toBe(false);
  });

  it("reads the settings again on refresh", async () => {
    let revision = "rev-1";
    stubFetch({ "/api/settings": () => json(payload({ revision })) });
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.payload?.revision).toBe("rev-1"));
    revision = "rev-2";
    await act(() => result.current.refresh());
    expect(result.current.payload?.revision).toBe("rev-2");
  });

  it("follows a reconnect to another deployment", async () => {
    const fetchMock = stubFetch({ "/api/settings": () => json(payload()) });
    const { result, rerender } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.payload).toBeDefined());
    deployment.deploymentUrl = "http://127.0.0.1:6606/";
    rerender();
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
        "http://127.0.0.1:6606/api/settings"
      )
    );
  });
});

describe("useSettingsAccess", () => {
  beforeEach(() => {
    deployment.deploymentUrl = "http://127.0.0.1:6174";
    deployment.apiKey = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is undefined while checking, then writable for the local backend", async () => {
    stubFetch({
      "/api/settings": () => json(payload()),
      "/api/settings/access": () => json(access()),
    });
    const { result } = renderHook(() => useSettingsAccess(), { wrapper });
    expect(result.current.access).toBeUndefined();
    await waitFor(() =>
      expect(result.current.access).toEqual({ writable: true })
    );
  });

  it("is read-only when the page reads another backend than the relay writes to", async () => {
    stubFetch({
      "/api/settings": () => json(payload({ instance: "fedcba9876543210" })),
      "/api/settings/access": () => json(access()),
    });
    const { result } = renderHook(() => useSettingsAccess(), { wrapper });
    await waitFor(() =>
      expect(result.current.access).toEqual({
        writable: false,
        reason: "other_backend",
      })
    );
  });

  it("passes the relay's reason through", async () => {
    stubFetch({
      "/api/settings": () => json(payload()),
      "/api/settings/access": () =>
        json({ writable: false, reason: "host_not_loopback" }),
    });
    const { result } = renderHook(() => useSettingsAccess(), { wrapper });
    await waitFor(() =>
      expect(result.current.access).toEqual({
        writable: false,
        reason: "host_not_loopback",
      })
    );
  });

  it("is unsupported against a backend without settings", async () => {
    stubFetch({
      "/api/settings": () => json({}, 404),
      "/api/settings/access": () =>
        json({ writable: false, reason: "unsupported" }),
    });
    const { result } = renderHook(() => useSettingsAccess(), { wrapper });
    await waitFor(() =>
      expect(result.current.access).toEqual({
        writable: false,
        reason: "unsupported",
      })
    );
  });

  it("is read-only when the backend cannot be read", async () => {
    stubFetch({
      "/api/settings": () => Promise.reject(new TypeError("Failed to fetch")),
      "/api/settings/access": () => json(access()),
    });
    const { result } = renderHook(() => useSettingsAccess(), { wrapper });
    await waitFor(() =>
      expect(result.current.access).toEqual({
        writable: false,
        reason: "backend_unreachable",
      })
    );
  });

  it("refresh checks the relay and the settings again", async () => {
    const fetchMock = stubFetch({
      "/api/settings": () => json(payload()),
      "/api/settings/access": () => json(access()),
    });
    const { result } = renderHook(() => useSettingsAccess(), { wrapper });
    await waitFor(() =>
      expect(result.current.access).toEqual({ writable: true })
    );
    fetchMock.mockClear();
    await act(() => result.current.refresh());
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/api/settings/access");
    expect(urls).toContain("http://127.0.0.1:6174/api/settings");
  });
  it("checks the relay once the backend answers, not while it is down", async () => {
    let up = false;
    const fetchMock = stubFetch({
      "/api/settings": () =>
        up ? json(payload()) : Promise.reject(new TypeError("Failed to fetch")),
      "/api/settings/access": () =>
        json(
          up ? access() : { writable: false, reason: "backend_unreachable" }
        ),
    });
    const { result } = renderHook(
      () => ({ settings: useSettings(), relay: useSettingsAccess() }),
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current.relay.access).toEqual({
        writable: false,
        reason: "backend_unreachable",
      })
    );
    up = true;
    await act(() => result.current.settings.refresh());
    await waitFor(() =>
      expect(result.current.relay.access).toEqual({ writable: true })
    );
    expect(
      fetchMock.mock.calls.filter(
        (c) => String(c[0]) === "/api/settings/access"
      )
    ).toHaveLength(1);
  });
});
