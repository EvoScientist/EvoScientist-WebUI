// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import {
  AUTOSKILLS_REFRESH_MS,
  markAutoSeen,
  readAutoSeenAt,
  refreshAutoSkills,
  useAutoSkills,
  useDraftFile,
} from "@/app/hooks/useAutoSkills";
import type { Draft } from "@/lib/autoskills";

const deployment = { deploymentUrl: "http://127.0.0.1:6174", apiKey: "" };
vi.mock("@/providers/ClientProvider", () => ({
  useDeployment: () => deployment,
}));

const draft = (id: string) => ({
  proposal_id: id,
  skill_name: "arxiv-paper-retrieval",
  description: "d",
  operation: "create",
  target_skill_name: null,
  scope: "workspace",
  submitted_scope: null,
  status: "pending",
  workspace_dir: "/w",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  approved_at: null,
  approved_by: null,
  rejected_at: null,
  approved_skill_path: null,
  approved_skill_present: null,
  source_observation_ids: [],
  skill_md: "x",
  skill_md_truncated: false,
  rationale_md: "y",
  rationale_md_truncated: false,
  files: [],
  install_target: null,
  install_base: null,
  install_error: null,
});
const list = (ids: string[] = ["a"]) => ({
  proposals: ids.map(draft),
  counts: { pending: ids.length, approved: 0, rejected: 0 },
  by_project: {},
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _i?: RequestInit) =>
    answer(String(input))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  deployment.deploymentUrl = "http://127.0.0.1:6174";
  deployment.apiKey = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAutoSkills", () => {
  it("reads the drafts once for every reader", async () => {
    const fetchMock = stubFetch(() => json(list()));
    const { result } = renderHook(
      () => [useAutoSkills(), useAutoSkills(), useAutoSkills()] as const,
      { wrapper }
    );
    await waitFor(() => expect(result.current[0].status).toBe("ready"));
    expect(result.current.every((r) => r.status === "ready")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6174/api/autoskills/proposals"
    );
  });

  it("a 404 reads as unsupported", async () => {
    stubFetch(() => json({}, 404));
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unsupported"));
  });

  // Every page mounts the rail's count: an EvoScientist without the route
  // isn't asked again every minute from every tab.
  describe("on the interval", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const settle = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it("stops asking once the answer is unsupported", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json({}, 404));
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await settle(10);
      expect(result.current.status).toBe("unsupported");
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 3);
      expect(fetchMock.mock.calls.length).toBe(asked);
    });

    it("keeps reading a list", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await settle(10);
      expect(result.current.status).toBe("ready");
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS + 10);
      expect(fetchMock.mock.calls.length).toBe(asked + 1);
    });
  });

  it("a 405 reads as unsupported", async () => {
    stubFetch(() => json({}, 405));
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unsupported"));
  });

  it("a failed re-read shows the error, not the old list", async () => {
    const answers = [json(list(["a"])), json({}, 500), json(list(["b"]))];
    stubFetch(() => answers.shift()!);
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.refresh().catch(() => {});
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("a body without proposals is an error", async () => {
    stubFetch(() => json({ counts: {} }));
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("sends the deployment's API key", async () => {
    deployment.apiKey = "k1";
    const fetchMock = stubFetch(() => json(list()));
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("k1");
  });

  it("a deployment switch reads the new backend and shows loading meanwhile", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = stubFetch((url) =>
      url.includes(":7000")
        ? new Promise<Response>((r) => (release = r))
        : json(list(["a"]))
    );
    const { result, rerender } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    deployment.deploymentUrl = "http://127.0.0.1:7000/";
    rerender();
    expect(result.current.status).toBe("loading");
    await act(async () => release(json(list(["b"]))));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const last = fetchMock.mock.calls.at(-1)![0];
    expect(last).toBe("http://127.0.0.1:7000/api/autoskills/proposals");
    if (result.current.status === "ready") {
      expect(result.current.list.drafts[0].proposal_id).toBe("b");
    }
  });

  it("refreshAutoSkills makes every reader read again", async () => {
    // The global mutate reaches SWR's default cache, so no private provider.
    deployment.deploymentUrl = "http://127.0.0.1:6555";
    const fetchMock = stubFetch(() => json(list()));
    const { result } = renderHook(
      () => [useAutoSkills(), useAutoSkills()] as const,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <SWRConfig value={{ dedupingInterval: 0 }}>{children}</SWRConfig>
        ),
      }
    );
    await waitFor(() => expect(result.current[0].status).toBe("ready"));
    const before = fetchMock.mock.calls.length;
    await act(async () => {
      await refreshAutoSkills();
    });
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});

describe("useDraftFile", () => {
  const d = draft("p 1") as unknown as Draft;

  it("asks for the installed copy with installed=1", async () => {
    const fetchMock = stubFetch(() => new Response("hello", { status: 200 }));
    const { result } = renderHook(() => useDraftFile(d, "a b/SKILL.md", true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.text).toBe("hello"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6174/api/autoskills/proposals/p%201/file?path=a%20b%2FSKILL.md&installed=1"
    );
  });

  it("maps 404, 413 and 415 to their messages, and anything else to the plain one", async () => {
    stubFetch((url) => {
      const status = Number(new URL(url).searchParams.get("path"));
      if (status === 500) return new Response("", { status });
      if (status === 1) throw new TypeError("Failed to fetch");
      return new Response("", { status });
    });
    const expected: Record<string, string> = {
      "404": "This file isn't there any more.",
      "413": "This file is too large to show here.",
      "415": "This file isn't text, so it isn't shown.",
    };
    for (const [status, message] of Object.entries(expected)) {
      const h = renderHook(() => useDraftFile(d, status, false), { wrapper });
      await waitFor(() => expect(h.result.current.error).toBe(message));
      h.unmount();
    }
  });

  it("a rejected fetch reads as the plain message", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const h = renderHook(() => useDraftFile(d, "x", false), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SWRConfig
          value={{
            provider: () => new Map(),
            dedupingInterval: 0,
            shouldRetryOnError: false,
          }}
        >
          {children}
        </SWRConfig>
      ),
    });
    await waitFor(() =>
      expect(h.result.current.error).toBe("Couldn't read this file.")
    );
  });

  // A tiny retry interval, so SWR's default retry would fire within the wait.
  const fastRetry = ({ children }: { children: ReactNode }) => (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        errorRetryInterval: 10,
      }}
    >
      {children}
    </SWRConfig>
  );

  it("a 413 is fetched once", async () => {
    const fetchMock = stubFetch(() => new Response("", { status: 413 }));
    const h = renderHook(() => useDraftFile(d, "x", false), {
      wrapper: fastRetry,
    });
    await waitFor(() => expect(h.result.current.error).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 400 is fetched once and reads as the plain message", async () => {
    // The core's answer to a path it refuses ("../x", an absolute path, none).
    const fetchMock = stubFetch(() => json({ error: "invalid_path" }, 400));
    const h = renderHook(() => useDraftFile(d, "../x", false), {
      wrapper: fastRetry,
    });
    await waitFor(() =>
      expect(h.result.current.error).toBe("Couldn't read this file.")
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads again when the draft is rewritten", async () => {
    let n = 0;
    const fetchMock = stubFetch(() => new Response(`v${++n}`, { status: 200 }));
    const h = renderHook(
      ({ dr }: { dr: Draft }) => useDraftFile(dr, "SKILL.md", false),
      { wrapper, initialProps: { dr: d } }
    );
    await waitFor(() => expect(h.result.current.text).toBe("v1"));
    // The same draft, unchanged: the text read is kept.
    h.rerender({ dr: { ...d } });
    expect(h.result.current.text).toBe("v1");
    // A run rewrote it in place (same id, new updated_at).
    h.rerender({ dr: { ...d, updated_at: "2026-11-02T00:00:00Z" } });
    await waitFor(() => expect(h.result.current.text).toBe("v2"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a 500 is retried", async () => {
    const fetchMock = stubFetch(() => new Response("", { status: 500 }));
    renderHook(() => useDraftFile(d, "x", false), { wrapper: fastRetry });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });
});

describe("seen-at", () => {
  it("is kept per deployment and survives a storage that throws", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readAutoSeenAt("u1")).toBeNull();
    markAutoSeen("u1", "2026-11-01T00:00:00Z");
    markAutoSeen("u2", "2026-11-02T00:00:00Z");
    expect(readAutoSeenAt("u1")).toBe("2026-11-01T00:00:00Z");
    expect(readAutoSeenAt("u2")).toBe("2026-11-02T00:00:00Z");
    store.set("evoscientist-autoskills-seen-at", "{not json");
    expect(readAutoSeenAt("u1")).toBeNull();
    markAutoSeen("http://h:1/", "slash");
    expect(readAutoSeenAt("http://h:1")).toBe("slash");
    markAutoSeen("u3", "t");
    expect(readAutoSeenAt("u3")).toBe("t");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readAutoSeenAt("u1")).toBeNull();
    expect(() => markAutoSeen("u1", "t")).not.toThrow();
  });
});
