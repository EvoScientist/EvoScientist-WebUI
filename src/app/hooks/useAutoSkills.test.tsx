// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, unstable_serialize } from "swr";
import {
  AUTOSKILLS_REFRESH_MS,
  CHECK_DEADLINE_MS,
  READ_TIMEOUT_MS,
  markAutoSeen,
  readAutoSeenAt,
  refreshAutoSkills,
  useAutoSkills,
  useDraftFile,
  useDraftFilesCheck,
} from "@/app/hooks/useAutoSkills";
import type { Draft, UnshowableFile } from "@/lib/autoskills";

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

    it("never asks an old core on the interval, however often its caller renders", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json({}, 404));
      const { result, rerender } = renderHook(() => useAutoSkills(), {
        wrapper,
      });
      await settle(10);
      expect(result.current.status).toBe("unsupported");
      const asked = fetchMock.mock.calls.length;
      // Six minutes, with a render every 30 s.
      for (let i = 0; i < 12; i++) {
        await settle(AUTOSKILLS_REFRESH_MS / 2);
        rerender();
      }
      expect(fetchMock.mock.calls.length).toBe(asked);
      expect(result.current.status).toBe("unsupported");
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

    // SWR keeps a request in flight for its key, and every later read of the
    // key waits for it: one that never answered stopped the list for good.
    it("a read that never answers gives up after 15 s, and the list reads again", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const fetchMock = stubFetch(() => {
        calls += 1;
        return calls === 1 ? new Promise<Response>(() => {}) : json(list());
      });
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await settle(READ_TIMEOUT_MS - 10);
      expect(result.current.status).toBe("loading");
      const first = fetchMock.mock.calls[0][1] as RequestInit;
      expect(first.signal?.aborted).toBe(false);
      await settle(10);
      // Given up on: aborted, and read like any failed read.
      expect(first.signal?.aborted).toBe(true);
      expect(result.current.status).toBe("error");
      // SWR's own retry starts a new request, which answers.
      await settle(10_000);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(result.current.status).toBe("ready");
    });

    it("a draft file that never answers reads as a failed read, then reads again", async () => {
      vi.useFakeTimers();
      let calls = 0;
      stubFetch(() => {
        calls += 1;
        return calls === 1
          ? new Promise<Response>(() => {})
          : new Response("hello", { status: 200 });
      });
      const d = draft("p") as unknown as Draft;
      const { result } = renderHook(() => useDraftFile(d, "SKILL.md", false), {
        wrapper,
      });
      await settle(READ_TIMEOUT_MS);
      expect(result.current.error).toBe("Couldn't read this file.");
      // Not a final answer: asked again.
      await settle(10_000);
      expect(result.current.text).toBe("hello");
      expect(result.current.error).toBeNull();
    });

    it("a reader that doesn't poll adds no reads to the one that does", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      function Quiet() {
        useAutoSkills({ poll: false });
        return null;
      }
      function Rail() {
        useAutoSkills();
        return null;
      }
      const tree = (rail: boolean) => (
        <SWRConfig value={{ provider: () => new Map() }}>
          <Quiet />
          {rail && <Rail />}
        </SWRConfig>
      );
      // The Run-now provider's reader from the start; the rail 20 s later.
      const view = render(tree(false));
      await settle(20_000);
      view.rerender(tree(true));
      // The rail's own first read (on its mount) lands first.
      await settle(1_000);
      const asked = fetchMock.mock.calls.length;
      // Five minutes: the rail's own minute only.
      await settle(AUTOSKILLS_REFRESH_MS * 5);
      expect(fetchMock.mock.calls.length).toBe(asked + 5);
      view.unmount();
    });

    // The rail, the Skills page, the banner and the drafts page each read
    // the list. With an interval per reader, readers mounted at different
    // times read it as many times a minute: one timer per list reads once.
    it("readers mounted at different times read once a minute together, on one timer", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      function Reader() {
        useAutoSkills();
        return null;
      }
      const tree = (readers: number) => (
        <SWRConfig value={{ provider: () => new Map() }}>
          {Array.from({ length: readers }, (_, i) => (
            <Reader key={i} />
          ))}
        </SWRConfig>
      );
      const view = render(tree(1));
      await settle(20_000);
      view.rerender(tree(2));
      await settle(20_000);
      view.rerender(tree(3));
      // Each reader's own first read (on its mount) has landed.
      await settle(1_000);
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 5);
      expect(fetchMock.mock.calls.length).toBe(asked + 5);
      expect(vi.getTimerCount()).toBe(1);

      // Two of them go: the timer stays for the third, at its rhythm.
      view.rerender(tree(1));
      await settle(AUTOSKILLS_REFRESH_MS * 2);
      expect(fetchMock.mock.calls.length).toBe(asked + 7);
      expect(vi.getTimerCount()).toBe(1);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("with no polling reader mounted there is no timer, and one that mounts again starts it", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      function Quiet() {
        useAutoSkills({ poll: false });
        return null;
      }
      function Rail() {
        useAutoSkills();
        return null;
      }
      const tree = (rail: boolean) => (
        <SWRConfig value={{ provider: () => new Map() }}>
          <Quiet />
          {rail && <Rail />}
        </SWRConfig>
      );
      // Run now's reader alone: it doesn't count.
      const view = render(tree(false));
      await settle(5_000);
      expect(vi.getTimerCount()).toBe(0);
      view.rerender(tree(true));
      await settle(5_000);
      expect(vi.getTimerCount()).toBe(1);

      // The sidebar closes: the rail's reader goes, and the timer with it.
      view.rerender(tree(false));
      await settle(5_000);
      expect(vi.getTimerCount()).toBe(0);
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 5);
      expect(fetchMock.mock.calls.length).toBe(asked);

      // It opens again: read on the mount, then a minute apart.
      view.rerender(tree(true));
      await settle(1_000);
      const again = fetchMock.mock.calls.length;
      expect(again).toBe(asked + 1);
      await settle(AUTOSKILLS_REFRESH_MS * 3);
      expect(fetchMock.mock.calls.length).toBe(again + 3);
      // (Past SWR's own short timers after a read.)
      await settle(5_000);
      expect(vi.getTimerCount()).toBe(1);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("an old core isn't asked on the interval; once a read finds it updated, the list is polled again", async () => {
      vi.useFakeTimers();
      let updated = false;
      const fetchMock = stubFetch(() =>
        updated ? json(list()) : json({}, 404)
      );
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await settle(10);
      expect(result.current.status).toBe("unsupported");
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 5);
      expect(fetchMock.mock.calls.length).toBe(asked);

      // A read on focus finds the routes.
      updated = true;
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.status).toBe("ready");
      const found = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 3);
      expect(fetchMock.mock.calls.length).toBe(found + 3);
    });

    it("skips its minute while the tab is hidden or the browser is offline", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      renderHook(() => useAutoSkills(), { wrapper });
      await settle(10);
      const asked = fetchMock.mock.calls.length;
      const hidden = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("hidden");
      const offline = vi.spyOn(navigator, "onLine", "get");
      try {
        await settle(AUTOSKILLS_REFRESH_MS * 3);
        expect(fetchMock.mock.calls.length).toBe(asked);
        hidden.mockReturnValue("visible");
        offline.mockReturnValue(false);
        await settle(AUTOSKILLS_REFRESH_MS * 2);
        expect(fetchMock.mock.calls.length).toBe(asked);
        // Visible and online: the next minute reads.
        offline.mockReturnValue(true);
        await settle(AUTOSKILLS_REFRESH_MS);
        expect(fetchMock.mock.calls.length).toBe(asked + 1);
      } finally {
        hidden.mockRestore();
        offline.mockRestore();
      }
    });

    it("leaves a failed read to SWR's retry, and reads again once one answers", async () => {
      vi.useFakeTimers();
      let down = false;
      const fetchMock = stubFetch(() => (down ? json({}, 500) : json(list())));
      // Without SWR's retry, so every read counted here is the timer's.
      const { result } = renderHook(() => useAutoSkills(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <SWRConfig
            value={{ provider: () => new Map(), shouldRetryOnError: false }}
          >
            {children}
          </SWRConfig>
        ),
      });
      await settle(10);
      expect(result.current.status).toBe("ready");
      down = true;
      // The minute's read fails.
      await settle(AUTOSKILLS_REFRESH_MS);
      expect(result.current.status).toBe("error");
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 5);
      expect(fetchMock.mock.calls.length).toBe(asked);

      // A read answers (the retry, a focus read, the page's Retry).
      down = false;
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.status).toBe("ready");
      const answered = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 2);
      expect(fetchMock.mock.calls.length).toBe(answered + 2);
    });

    // SWR 2.4.1 starts a second request for a `mutate(key)` made while a read
    // of the key is out, and drops the first one's answer: a focus read that
    // would have brought the list was lost to a minute's read that failed.
    it("skips its minute while a read of the list is in flight, and that read's answer is what shows", async () => {
      vi.useFakeTimers();
      const start = Date.now();
      /** Run to `ms` after the mount (the timer's minutes are counted from
       *  it). */
      const until = (ms: number) => settle(start + ms - Date.now());
      // A read answers at once, unless the test holds it; while one is
      // held, any other read fails.
      let holdNext = false;
      let held: ((res: Response) => void) | null = null;
      const fetchMock = stubFetch(() => {
        if (holdNext) {
          holdNext = false;
          return new Promise<Response>((resolve) => {
            held = resolve;
          });
        }
        return held ? json({}, 500) : json(list(["a"]));
      });
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await until(10);
      expect(result.current.status).toBe("ready");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      /** The window is focused: SWR's focus read starts, and stays out. */
      const focus = async () => {
        holdNext = true;
        act(() => {
          window.dispatchEvent(new Event("focus"));
        });
        await settle(5);
        expect(held).not.toBeNull();
      };
      const answerHeld = async (ids: string[]) => {
        const answer = held as unknown as (res: Response) => void;
        held = null;
        await act(async () => {
          answer(json(list(ids)));
          await vi.advanceTimersByTimeAsync(10);
        });
      };
      const shown = () =>
        result.current.status === "ready" &&
        result.current.list.drafts.map((d) => d.proposal_id);

      // Focused 10 ms before the first minute.
      await until(AUTOSKILLS_REFRESH_MS - 10);
      await focus();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The minute comes round with that read out: nothing else is asked.
      await until(AUTOSKILLS_REFRESH_MS + 1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The held read answers, and its list is what shows.
      await answerHeld(["a", "b"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(shown()).toEqual(["a", "b"]);

      // Only that minute was skipped: the next one reads.
      await until(AUTOSKILLS_REFRESH_MS * 2 + 1_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(shown()).toEqual(["a"]);

      // A read out across a later minute is waited for as well.
      await until(AUTOSKILLS_REFRESH_MS * 3 - 10);
      await focus();
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await until(AUTOSKILLS_REFRESH_MS * 3 + 1_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await answerHeld(["a", "c"]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(shown()).toEqual(["a", "c"]);
    });

    // SWR writes `isValidating: false` only when a read it kept ends. A read
    // it discarded, with none started in its place, leaves the flag true in
    // the cache: a timer that waited for it would never read again.
    it("never skips two minutes in a row: with the flag left true, the minute after the skipped one reads", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      const cache = new Map<string, Record<string, unknown>>();
      const { result } = renderHook(() => useAutoSkills(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
            {children}
          </SWRConfig>
        ),
      });
      await settle(10);
      expect(result.current.status).toBe("ready");
      const asked = fetchMock.mock.calls.length;
      // The state SWR leaves behind: validating, with no read out.
      const id = unstable_serialize([
        "autoskills",
        "http://127.0.0.1:6174",
        "",
      ]);
      expect(cache.get(id)?.isValidating).toBe(false);
      cache.set(id, { ...cache.get(id), isValidating: true });

      // The first minute waits for the read it takes to be out.
      await settle(AUTOSKILLS_REFRESH_MS);
      expect(fetchMock.mock.calls.length).toBe(asked);
      // The second reads whatever the flag says, and its read clears it.
      await settle(AUTOSKILLS_REFRESH_MS);
      expect(fetchMock.mock.calls.length).toBe(asked + 1);
      expect(cache.get(id)?.isValidating).toBe(false);
      await settle(AUTOSKILLS_REFRESH_MS);
      expect(fetchMock.mock.calls.length).toBe(asked + 2);
    });

    // The mark of a skipped minute is for the minute right after it. One
    // that asked nothing for another reason left it set, so the next read in
    // flight wasn't waited for: the timer's request replaced it, and the
    // page showed that one's failure.
    it.each<[string, "hidden" | "offline" | "unsupported" | "failed"]>([
      ["the tab was hidden", "hidden"],
      ["the browser was offline", "offline"],
      ["the list read as unsupported", "unsupported"],
      ["the latest read had failed", "failed"],
    ])(
      "waits for a read in flight again after a minute that asked nothing because %s",
      async (_why, why) => {
        vi.useFakeTimers();
        const start = Date.now();
        const until = (ms: number) => settle(start + ms - Date.now());
        // A read answers `status` at once, unless the test holds it; while
        // one is held, any other read fails.
        let status = 200;
        let holdNext = false;
        let held: ((res: Response) => void) | null = null;
        const fetchMock = stubFetch(() => {
          if (holdNext) {
            holdNext = false;
            return new Promise<Response>((resolve) => {
              held = resolve;
            });
          }
          if (held) return json({}, 500);
          return status === 200 ? json(list(["a"])) : json({}, status);
        });
        // Without SWR's retry, so a failed read stays the latest one.
        const { result } = renderHook(() => useAutoSkills(), {
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
        await until(10);
        expect(result.current.status).toBe("ready");
        const focus = async () => {
          holdNext = true;
          act(() => {
            window.dispatchEvent(new Event("focus"));
          });
          await settle(5);
          expect(held).not.toBeNull();
        };
        const answerHeld = async (ids: string[]) => {
          const answer = held as unknown as (res: Response) => void;
          held = null;
          await act(async () => {
            answer(json(list(ids)));
            await vi.advanceTimersByTimeAsync(10);
          });
        };
        /** A read outside the timer (the page's Retry) answers `next`. */
        const read = async (next: number) => {
          status = next;
          await act(async () => {
            await result.current.refresh();
          });
        };
        const shown = () =>
          result.current.status === "ready" &&
          result.current.list.drafts.map((d) => d.proposal_id);
        const hidden = vi.spyOn(document, "visibilityState", "get");
        const offline = vi.spyOn(navigator, "onLine", "get");
        try {
          // The first minute is skipped for a focus read in flight.
          await until(AUTOSKILLS_REFRESH_MS - 10);
          await focus();
          await until(AUTOSKILLS_REFRESH_MS + 1_000);
          expect(fetchMock).toHaveBeenCalledTimes(2);
          await answerHeld(["a", "b"]);
          expect(shown()).toEqual(["a", "b"]);

          // The second asks nothing, for another reason.
          if (why === "hidden") hidden.mockReturnValue("hidden");
          if (why === "offline") offline.mockReturnValue(false);
          if (why === "unsupported") {
            await read(404);
            expect(result.current.status).toBe("unsupported");
          }
          if (why === "failed") {
            await read(500);
            expect(result.current.status).toBe("error");
          }
          const before = fetchMock.mock.calls.length;
          await until(AUTOSKILLS_REFRESH_MS * 2 + 1_000);
          expect(fetchMock.mock.calls.length).toBe(before);
          if (why === "hidden") hidden.mockReturnValue("visible");
          if (why === "offline") offline.mockReturnValue(true);
          if (why === "unsupported" || why === "failed") await read(200);
          expect(result.current.status).toBe("ready");

          // The third comes round with a focus read out again: that read is
          // waited for, and its answer is what shows.
          await until(AUTOSKILLS_REFRESH_MS * 3 - 10);
          await focus();
          const asked = fetchMock.mock.calls.length;
          await until(AUTOSKILLS_REFRESH_MS * 3 + 1_000);
          expect(fetchMock.mock.calls.length).toBe(asked);
          await answerHeld(["a", "c"]);
          expect(fetchMock.mock.calls.length).toBe(asked);
          expect(shown()).toEqual(["a", "c"]);
        } finally {
          hidden.mockRestore();
          offline.mockRestore();
        }
      }
    );

    it("a deployment switch moves the timer to the new backend's list", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      const { rerender, unmount } = renderHook(() => useAutoSkills(), {
        wrapper,
      });
      await settle(10);
      deployment.deploymentUrl = "http://127.0.0.1:7000";
      rerender();
      await settle(10);
      const asked = fetchMock.mock.calls.length;
      await settle(AUTOSKILLS_REFRESH_MS * 3);
      expect(
        fetchMock.mock.calls.slice(asked).map((call) => String(call[0]))
      ).toEqual(
        Array(3).fill("http://127.0.0.1:7000/api/autoskills/proposals")
      );
      await settle(5_000);
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    // The rail re-renders on its own 60 s clock: a render must not start the
    // interval over, or it never comes round.
    it("keeps its rhythm while the caller re-renders every 30 s", async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch(() => json(list()));
      const { result, rerender } = renderHook(() => useAutoSkills(), {
        wrapper,
      });
      await settle(10);
      expect(result.current.status).toBe("ready");
      const asked = fetchMock.mock.calls.length;
      // Five minutes.
      for (let i = 0; i < 10; i++) {
        await settle(AUTOSKILLS_REFRESH_MS / 2);
        rerender();
      }
      expect(fetchMock.mock.calls.length).toBe(asked + 5);
    });
  });

  it("a 405 reads as unsupported", async () => {
    stubFetch(() => json({}, 405));
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unsupported"));
  });

  it("says whether a read of the list is in flight", async () => {
    let answer: (res: Response) => void = () => {};
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.isValidating).toBe(true));
    await act(async () => answer(json(list())));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.isValidating).toBe(false);

    // A re-read is out, then lands.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(result.current.isValidating).toBe(true));
    await act(async () => answer(json(list())));
    await waitFor(() => expect(result.current.isValidating).toBe(false));
  });

  it("a reader that doesn't ask about reads in flight isn't rendered again for one", async () => {
    stubFetch(() => json(list()));
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useAutoSkills();
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = renders;
    // Equal data: SWR keeps the list, and the read starting and ending
    // renders nothing for this reader.
    await act(async () => {
      await result.current.refresh();
    });
    expect(renders).toBe(before);
  });

  // The status follows the latest read, so no reader takes old numbers for
  // current ones; the last good list comes with the error for a caller
  // that keeps showing it and says so (the drafts page).
  it("a failed re-read is an error, with the last good list beside it", async () => {
    const answers = [json(list(["a"])), json({}, 500), json(list(["b"]))];
    stubFetch(() => answers.shift()!);
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const read = result.current.status === "ready" ? result.current.list : null;
    expect(read?.drafts[0].proposal_id).toBe("a");
    await act(async () => {
      await result.current.refresh().catch(() => {});
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    // The same object: nothing that compares lists sees a new one.
    expect(result.current.status === "error" && result.current.list).toBe(read);
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      result.current.status === "ready" &&
        result.current.list.drafts[0].proposal_id
    ).toBe("b");
  });

  // What the drafts page counts on: through a failed read and a recovery
  // with equal drafts the list is one object, so nothing that compares
  // lists (its picks, its holds) sees a change.
  it("a read that answers equal drafts after a failed one gives the same list object back", async () => {
    const answers = [json(list(["a"])), json({}, 500), json(list(["a"]))];
    stubFetch(() => answers.shift()!);
    const { result } = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const read = result.current.status === "ready" ? result.current.list : null;
    await act(async () => {
      await result.current.refresh().catch(() => {});
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.status === "error" && result.current.list).toBe(read);
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.status === "ready" && result.current.list).toBe(read);
  });

  it("an error without a list read before it has none", async () => {
    // A first read that fails.
    stubFetch(() => json({}, 500));
    const first = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(first.result.current.status).toBe("error"));
    expect("list" in first.result.current).toBe(false);
    first.unmount();

    // An old core's answer, then a failed read: no list either.
    const answers = [json({}, 404), json({}, 500)];
    stubFetch(() => answers.shift() ?? json({}, 500));
    const old = renderHook(() => useAutoSkills(), { wrapper });
    await waitFor(() => expect(old.result.current.status).toBe("unsupported"));
    await act(async () => {
      await old.result.current.refresh().catch(() => {});
    });
    await waitFor(() => expect(old.result.current.status).toBe("error"));
    expect("list" in old.result.current).toBe(false);
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

  // SWR's mutate resolves with the last good list when a read fails, so a
  // caller that needs the list as it is now reads it directly.
  describe("readNow", () => {
    it("reads the backend, never the cache, and leaves the cache to SWR", async () => {
      // The page's read, readNow's own, then SWR's read after it.
      const answers = [json(list(["a"])), json(list(["b"])), json(list(["b"]))];
      const fetchMock = stubFetch(() => answers.shift() ?? json({}, 500));
      const { result } = renderHook(
        () => [useAutoSkills(), useAutoSkills()] as const,
        { wrapper }
      );
      await waitFor(() => expect(result.current[0].status).toBe("ready"));
      let read: unknown;
      await act(async () => {
        read = await result.current[0].readNow();
      });
      expect(
        (read as { drafts: Array<{ proposal_id: string }> }).drafts[0]
      ).toMatchObject({ proposal_id: "b" });
      // The readers follow SWR's own read, made once readNow settled.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      await waitFor(() =>
        expect(
          result.current.map(
            (r) => r.status === "ready" && r.list.drafts[0].proposal_id
          )
        ).toEqual(["b", "b"])
      );
      // A failed read fails: no list from before comes back as current.
      await act(async () => {
        await expect(result.current[0].readNow()).rejects.toThrow();
      });
    });

    it("a slow direct read doesn't write over a newer read of the list", async () => {
      // A draft approved meanwhile: SWR's read has it, the slow direct read
      // still had it Pending.
      let slow: (r: Response) => void = () => {};
      let held: (r: Response) => void = () => {};
      let calls = 0;
      const fetchMock = stubFetch(() => {
        calls += 1;
        if (calls === 1) return json(list(["a"]));
        if (calls === 2) return new Promise<Response>((r) => (slow = r));
        if (calls === 3) return json(list(["newer"]));
        return new Promise<Response>((r) => (held = r));
      });
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      let direct: Promise<unknown> = Promise.resolve();
      act(() => {
        direct = result.current.readNow();
      });
      await act(async () => {
        await result.current.refresh();
      });
      expect(
        result.current.status === "ready" &&
          result.current.list.drafts[0].proposal_id
      ).toBe("newer");
      await act(async () => {
        slow(json(list(["older"])));
        await direct;
      });
      // The caller has its answer; the readers keep the newer list.
      expect(
        result.current.status === "ready" &&
          result.current.list.drafts[0].proposal_id
      ).toBe("newer");
      // SWR reads again after it, in its own order.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
      await act(async () => {
        held(json(list(["newest"])));
      });
      await waitFor(() =>
        expect(
          result.current.status === "ready" &&
            result.current.list.drafts[0].proposal_id
        ).toBe("newest")
      );
    });

    it("can be cut short", async () => {
      stubFetch(() => json(list()));
      const { result } = renderHook(() => useAutoSkills(), { wrapper });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const aborting = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      );
      vi.stubGlobal("fetch", aborting);
      const controller = new AbortController();
      let outcome: Promise<unknown> = Promise.resolve();
      act(() => {
        outcome = result.current.readNow(controller.signal);
      });
      controller.abort();
      await expect(outcome).rejects.toThrow();
      // The caller's abort reaches the request (through the 15 s bound).
      expect(aborting.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it("an answer for a deployment left meanwhile stays that deployment's", async () => {
      let late: (r: Response) => void = () => {};
      let calls = 0;
      stubFetch((url) => {
        calls += 1;
        if (url.includes(":7000")) return json(list(["b"]));
        // The first read is the page's; the second is readNow's, held.
        return calls === 1
          ? json(list(["a"]))
          : new Promise<Response>((r) => (late = r));
      });
      const { result, rerender } = renderHook(() => useAutoSkills(), {
        wrapper,
      });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      let held: Promise<unknown> = Promise.resolve();
      act(() => {
        held = result.current.readNow();
      });
      deployment.deploymentUrl = "http://127.0.0.1:7000";
      rerender();
      await waitFor(() =>
        expect(
          result.current.status === "ready" &&
            result.current.list.drafts[0].proposal_id
        ).toBe("b")
      );
      await act(async () => {
        late(json(list(["old"])));
        await held;
      });
      expect(
        result.current.status === "ready" &&
          result.current.list.drafts[0].proposal_id
      ).toBe("b");
    });
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
      "404": "This file is gone or can't be read.",
      "413": "This file is too large to show here.",
      "415": "This file isn't text, so it isn't shown.",
    };
    for (const [status, message] of Object.entries(expected)) {
      const h = renderHook(() => useDraftFile(d, status, false), { wrapper });
      await waitFor(() => expect(h.result.current.error).toBe(message));
      h.unmount();
    }
  });

  // A decided draft's rationale is its own RATIONALE.md, never the installed
  // skill's; a draft without one answers 404, which the pane words itself.
  it("reads a draft's RATIONALE.md, and says which status a failed read answered", async () => {
    const fetchMock = stubFetch((url) => {
      const path = new URL(url).searchParams.get("path");
      if (path === "RATIONALE.md") return json({ error: "not_found" }, 404);
      if (path === "big.md") return new Response("", { status: 413 });
      if (path === "offline.md") throw new TypeError("Failed to fetch");
      return new Response("# skill", { status: 200 });
    });
    const noRetry = ({ children }: { children: ReactNode }) => (
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    );
    const why = renderHook(() => useDraftFile(d, "RATIONALE.md", false), {
      wrapper: noRetry,
    });
    await waitFor(() => expect(why.result.current.status).toBe(404));
    expect(why.result.current.error).toBe(
      "This file is gone or can't be read."
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6174/api/autoskills/proposals/p%201/file?path=RATIONALE.md"
    );
    why.unmount();

    const big = renderHook(() => useDraftFile(d, "big.md", false), {
      wrapper: noRetry,
    });
    await waitFor(() => expect(big.result.current.status).toBe(413));
    big.unmount();

    // No answer at all: an error without a status.
    const offline = renderHook(() => useDraftFile(d, "offline.md", false), {
      wrapper: noRetry,
    });
    await waitFor(() =>
      expect(offline.result.current.error).toBe("Couldn't read this file.")
    );
    expect(offline.result.current.status).toBeNull();
    offline.unmount();

    // A read that answers has none either.
    const skill = renderHook(() => useDraftFile(d, "SKILL.md", false), {
      wrapper: noRetry,
    });
    await waitFor(() => expect(skill.result.current.text).toBe("# skill"));
    expect(skill.result.current.status).toBeNull();
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

  it("a 404 is fetched once: the file is gone or can't be read", async () => {
    // The core answers 404 for no such file or draft, no installed copy, and
    // a file it can't read.
    const fetchMock = stubFetch(() => json({ error: "not_found" }, 404));
    const h = renderHook(() => useDraftFile(d, "x", false), {
      wrapper: fastRetry,
    });
    await waitFor(() =>
      expect(h.result.current.error).toBe("This file is gone or can't be read.")
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

describe("useDraftFilesCheck", () => {
  const BIG = 1_048_577;
  const withFiles = (
    id: string,
    files: Array<[string, number]>,
    updated_at = "2026-11-01T00:00:00Z"
  ) =>
    ({
      ...draft(id),
      updated_at,
      files: files.map(([path, size]) => ({ path, size, installed: false })),
    } as unknown as Draft);
  const fileUrl = (id: string, path: string) =>
    `http://127.0.0.1:6174/api/autoskills/proposals/${encodeURIComponent(
      id
    )}/file?path=${encodeURIComponent(path)}`;
  type Found = ReadonlyMap<string, UnshowableFile[]>;

  it("answers at once, reading nothing, when every file is known by its size", () => {
    const fetchMock = stubFetch(() => new Response("x"));
    const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
    const out = result.current([
      withFiles("a", [["data/big.csv", BIG]]),
      withFiles("b", []),
    ]);
    expect(out).not.toBeInstanceOf(Promise);
    expect(out).toEqual(
      new Map([
        ["a", [{ path: "data/big.csv", size: BIG, reason: "too_large" }]],
      ])
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the draft's own copy of each file within the limit, and sorts the answers", async () => {
    const answers: Record<string, () => Response> = {
      "SKILL.md": () => new Response("# skill"),
      "grew.txt": () => new Response("", { status: 413 }),
      "logo.png": () => new Response("", { status: 415 }),
      "gone.md": () => json({ error: "not_found" }, 404),
      "broken.md": () => new Response("", { status: 500 }),
      "offline.md": () => {
        throw new TypeError("Failed to fetch");
      },
    };
    const fetchMock = stubFetch((url) => {
      const path = new URL(url).searchParams.get("path") ?? "";
      return answers[path]();
    });
    const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
    const d = withFiles("p 1", [
      ["SKILL.md", 7],
      ["data/big.csv", BIG],
      ["grew.txt", 10],
      ["logo.png", 2048],
      ["gone.md", 5],
      ["broken.md", 5],
      ["offline.md", 5],
    ]);
    const out = result.current([d]);
    expect(out).toBeInstanceOf(Promise);
    const found = await (out as Promise<Found>);
    expect(found).toEqual(
      new Map([
        [
          "p 1",
          [
            { path: "data/big.csv", size: BIG, reason: "too_large" },
            { path: "grew.txt", size: 10, reason: "too_large" },
            { path: "logo.png", size: 2048, reason: "not_text" },
            { path: "gone.md", size: 5, reason: "unchecked" },
            { path: "broken.md", size: 5, reason: "unchecked" },
            { path: "offline.md", size: 5, reason: "unchecked" },
          ],
        ],
      ])
    );
    // The Files tab's route, the draft's own copy; never the large file.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(6);
    expect(urls).toContain(fileUrl("p 1", "SKILL.md"));
    expect(urls.some((u) => u.includes("installed"))).toBe(false);
    expect(urls.some((u) => u.includes("big.csv"))).toBe(false);
  });

  it("reads at most four files at a time", async () => {
    let open = 0;
    let most = 0;
    const waiting: Array<() => void> = [];
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          open += 1;
          most = Math.max(most, open);
          waiting.push(() => {
            open -= 1;
            resolve(new Response("ok"));
          });
        })
    );
    const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
    const out = result.current([
      withFiles(
        "a",
        Array.from({ length: 6 }, (_, i) => [`a${i}.md`, 1] as [string, number])
      ),
      withFiles(
        "b",
        Array.from({ length: 4 }, (_, i) => [`b${i}.md`, 1] as [string, number])
      ),
    ]) as Promise<Found>;
    let answered = 0;
    while (answered < 10) {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      expect(open).toBeLessThanOrEqual(4);
      waiting.shift()!();
      answered += 1;
    }
    expect(await out).toEqual(new Map());
    expect(most).toBe(4);
  });

  it("gives up on a read after 15 s: the file couldn't be checked", async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => new Promise<Response>(() => {}));
      const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
      const out = result.current([
        withFiles("a", [["slow.md", 3]]),
      ]) as Promise<Found>;
      let found: Found | undefined;
      void out.then((f) => (found = f));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 10);
      });
      expect(found).toBeUndefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(found).toEqual(
        new Map([["a", [{ path: "slow.md", size: 3, reason: "unchecked" }]]])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the whole check after 20 s: the reads out are stopped, no other starts, and every file not answered couldn't be checked", async () => {
    vi.useFakeTimers();
    try {
      // A backend that never answers: each read gives up after 15 s, so 32
      // files would take two minutes four at a time.
      const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
      const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
      const paths = Array.from({ length: 32 }, (_, i) => `f${i}.md`);
      const out = result.current([
        withFiles(
          "a",
          paths.map((p) => [p, 3] as [string, number])
        ),
      ]) as Promise<Found>;
      let found: Found | undefined;
      void out.then((f) => (found = f));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHECK_DEADLINE_MS - 10);
      });
      expect(found).toBeUndefined();
      // Four at once, then four more once the first gave up at 15 s.
      expect(fetchMock).toHaveBeenCalledTimes(8);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(found).toEqual(
        new Map([
          ["a", paths.map((path) => ({ path, size: 3, reason: "unchecked" }))],
        ])
      );
      // The reads out were stopped, and none started after the deadline.
      for (const call of fetchMock.mock.calls.slice(4)) {
        expect((call[1]?.signal as AbortSignal).aborted).toBe(true);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 4);
      });
      expect(fetchMock).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a check the caller stops ends at once and reads nothing more", async () => {
    const fetchMock = stubFetch(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
    const stop = new AbortController();
    const out = result.current(
      [
        withFiles(
          "a",
          Array.from(
            { length: 6 },
            (_, i) => [`f${i}.md`, 3] as [string, number]
          )
        ),
      ],
      stop.signal
    ) as Promise<Found>;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    stop.abort();
    const found = await out;
    expect(found.get("a")?.map((f) => f.reason)).toEqual(
      Array(6).fill("unchecked")
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      expect((call[1]?.signal as AbortSignal).aborted).toBe(true);
    }

    // Stopped before it starts: nothing is read.
    const before = fetchMock.mock.calls.length;
    const again = await (result.current(
      [withFiles("b", [["SKILL.md", 3]])],
      stop.signal
    ) as Promise<Found>);
    expect(again).toEqual(
      new Map([["b", [{ path: "SKILL.md", size: 3, reason: "unchecked" }]]])
    );
    expect(fetchMock).toHaveBeenCalledTimes(before);
  });

  it("shares the Files tab's reads: a file it read opens at once, and one opened before isn't read again", async () => {
    const fetchMock = stubFetch((url) => {
      const path = new URL(url).searchParams.get("path");
      if (path === "logo.png") return new Response("", { status: 415 });
      return new Response(`text of ${path}`);
    });
    const d = withFiles("a", [
      ["SKILL.md", 7],
      ["run.py", 9],
      ["logo.png", 2048],
    ]);
    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) => ({
        check: useDraftFilesCheck(),
        file: useDraftFile(path ? d : null, path, false),
      }),
      { wrapper, initialProps: { path: "SKILL.md" as string | null } }
    );
    // SKILL.md opened in Files before the check.
    await waitFor(() =>
      expect(result.current.file.text).toBe("text of SKILL.md")
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const found = await (result.current.check([d]) as Promise<Found>);
    expect(found).toEqual(
      new Map([["a", [{ path: "logo.png", size: 2048, reason: "not_text" }]]])
    );
    // SKILL.md was not read again; run.py and logo.png were.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // run.py, read by the check, shows at once when opened (SWR may still
    // read it again behind the text, as for any file opened before).
    rerender({ path: "run.py" });
    expect(result.current.file.text).toBe("text of run.py");

    // Opened, logo.png answers 415 there too.
    rerender({ path: "logo.png" });
    await waitFor(() =>
      expect(result.current.file.error).toBe(
        "This file isn't text, so it isn't shown."
      )
    );
    // Now every answer is known: a second check reads nothing and answers at
    // once.
    const reads = fetchMock.mock.calls.length;
    const again = result.current.check([d]);
    expect(again).not.toBeInstanceOf(Promise);
    expect(again).toEqual(found);
    expect(fetchMock).toHaveBeenCalledTimes(reads);
  });

  it("reads a rewritten draft's files again", async () => {
    const fetchMock = stubFetch(() => new Response("ok"));
    const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
    await result.current([withFiles("a", [["SKILL.md", 2]])]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Read already: known.
    expect(result.current([withFiles("a", [["SKILL.md", 2]])])).toEqual(
      new Map()
    );
    // Same id, new updated_at: its current files are read.
    await result.current([
      withFiles("a", [["SKILL.md", 2]], "2026-11-02T00:00:00Z"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the deployment's API key", async () => {
    deployment.apiKey = "k-1";
    const fetchMock = stubFetch(() => new Response("ok"));
    const { result } = renderHook(() => useDraftFilesCheck(), { wrapper });
    await result.current([withFiles("a", [["SKILL.md", 2]])]);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "X-Api-Key": "k-1" });
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
