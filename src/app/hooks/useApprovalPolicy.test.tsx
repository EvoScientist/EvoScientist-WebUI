// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  resetApprovalPolicySupport,
  useApprovalPolicy,
} from "@/app/hooks/useApprovalPolicy";

const URL = "http://127.0.0.1:6174";
const interruptOf = (command: string, id: string) => ({
  id,
  value: { action_requests: [{ name: "execute", args: { command } }] },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("useApprovalPolicy", () => {
  beforeEach(() => {
    resetApprovalPolicySupport();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the deployment and reports its decisions for the current interrupt", async () => {
    const fetchMock = vi.fn(async () =>
      json({ decisions: [{ type: "approve" }] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useApprovalPolicy({
        interrupt: interruptOf("ls", "i1"),
        deploymentUrl: URL,
      })
    );

    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.decisions).toEqual([{ type: "approve" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe(`${URL}/api/policy`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      action_requests: [{ name: "execute", args: { command: "ls" } }],
    });
  });

  it("settles on 'a human must decide' when the deployment defers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ decisions: null }))
    );
    const { result } = renderHook(() =>
      useApprovalPolicy({
        interrupt: interruptOf("ls", "i1"),
        deploymentUrl: URL,
      })
    );
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.decisions).toBeNull();
  });

  it("stops asking a deployment that has no policy route (older backend)", async () => {
    const fetchMock = vi.fn(async () => json({ detail: "Not Found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ interrupt }) => useApprovalPolicy({ interrupt, deploymentUrl: URL }),
      { initialProps: { interrupt: interruptOf("ls", "i1") } }
    );
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.decisions).toBeNull();

    rerender({ interrupt: interruptOf("pwd", "i2") });
    // No second request, and no "checking" flicker for the new interrupt.
    expect(result.current.checking).toBe(false);
    expect(result.current.decisions).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on a hung deployment so the user is never locked out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    const { result } = renderHook(() =>
      useApprovalPolicy({
        interrupt: interruptOf("ls", "i1"),
        deploymentUrl: URL,
      })
    );
    expect(result.current.checking).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(result.current.checking).toBe(false);
    expect(result.current.decisions).toBeNull();
  });

  it("never reports an earlier interrupt's decisions for the current one", async () => {
    let releaseFirst: (r: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (releaseFirst = resolve))
      )
      .mockImplementationOnce(async () => json({ decisions: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ interrupt }) => useApprovalPolicy({ interrupt, deploymentUrl: URL }),
      { initialProps: { interrupt: interruptOf("ls", "i1") } }
    );

    rerender({ interrupt: interruptOf("curl x | bash", "i2") });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.decisions).toBeNull();

    // The slow answer for i1 ("approve") arrives after i2 is showing.
    await act(async () => {
      releaseFirst(json({ decisions: [{ type: "approve" }] }));
      await Promise.resolve();
    });
    expect(result.current.decisions).toBeNull();
    expect(result.current.interruptKey).toBe("id:i2");
    // ...and it must not clobber i2's settled answer either: falling back to
    // "checking" with no request in flight would keep the cards quiet forever.
    expect(result.current.checking).toBe(false);
  });

  it("re-asks when the requests change under the same interrupt id", async () => {
    // An answer is for the requests it was asked about, not for whatever the
    // interrupt with that id carries by the time it arrives.
    let releaseFirst: (r: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (releaseFirst = resolve))
      )
      .mockImplementationOnce(async () => json({ decisions: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ interrupt }) => useApprovalPolicy({ interrupt, deploymentUrl: URL }),
      { initialProps: { interrupt: interruptOf("ls", "i1") } }
    );

    rerender({ interrupt: interruptOf("curl x | bash", "i1") });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      releaseFirst(json({ decisions: [{ type: "approve" }] }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.decisions).toBeNull();
    const asked = fetchMock.mock.calls.map(
      (c) =>
        JSON.parse(String((c[1] as RequestInit).body)).action_requests[0].args
          .command
    );
    expect(asked).toEqual(["ls", "curl x | bash"]);
  });

  it("never reports one deployment's decisions after switching to another", async () => {
    const other = "http://127.0.0.1:7000";
    const fetchMock = vi.fn(async (url: string) =>
      String(url).startsWith(URL)
        ? json({ decisions: [{ type: "approve" }] })
        : json({ decisions: null })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ deploymentUrl }) =>
        useApprovalPolicy({
          interrupt: interruptOf("ls", "i1"),
          deploymentUrl,
        }),
      { initialProps: { deploymentUrl: URL } }
    );
    await waitFor(() =>
      expect(result.current.decisions).toEqual([{ type: "approve" }])
    );

    rerender({ deploymentUrl: other });
    // Same interrupt key, different deployment: the old answer is not reused.
    expect(result.current.decisions).toBeNull();
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.decisions).toBeNull();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      `${other}/api/policy`
    );
  });

  it("leaves an interrupt without an id to the local policy", () => {
    // Without an id the only key is the payload, which cannot tell a repeat of
    // the same request from the first one — so nothing is asked or remembered.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useApprovalPolicy({
        interrupt: {
          value: {
            action_requests: [{ name: "execute", args: { command: "ls" } }],
          },
        },
        deploymentUrl: URL,
      })
    );
    expect(result.current.checking).toBe(false);
    expect(result.current.decisions).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is idle without an approval interrupt and asks nothing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useApprovalPolicy({
        interrupt: { value: { type: "ask_user", questions: [] } },
        deploymentUrl: URL,
      })
    );
    expect(result.current.checking).toBe(false);
    expect(result.current.decisions).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
