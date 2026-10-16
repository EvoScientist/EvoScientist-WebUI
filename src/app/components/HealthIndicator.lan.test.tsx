// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://192.168.0.58:4716/"}
//
// The health light on a page opened on a LAN address. The backend's browser
// boundary refuses such a page before CORS, so the page only sees a network
// error; the tooltip has to say so instead of only asking whether the backend
// runs. From another device the loopback backend URL points at the device.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { HealthIndicator } from "./HealthIndicator";

const BACKEND = "http://127.0.0.1:6174";
const PLAIN = `Can't reach the backend at ${BACKEND}. Is "EvoSci deploy" running? Click to retry.`;
const rejected = () => Promise.reject(new TypeError("Failed to fetch"));
const answers = () =>
  Promise.resolve(new Response(JSON.stringify({ version: "0.15.1" })));

// `info` answers the saved URL's /info; `others` maps any other /info URL.
function stubFetch(
  info: (init?: RequestInit) => Promise<Response>,
  others: Record<string, () => Promise<Response>> = {}
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === `${BACKEND}/info`) return info(init);
    if (u.endsWith("/info")) return (others[u] ?? rejected)();
    return new Response(JSON.stringify({ port: 6174, deploymentUrl: BACKEND }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HealthIndicator on a page opened on another address", () => {
  it("gives the remedies for a rejected request", async () => {
    stubFetch(rejected);
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    const indicator = await screen.findByRole("button", {
      name: /from this page, http:\/\/192\.168\.0\.58:4716/,
    });
    const title = indicator.getAttribute("title") ?? "";
    expect(title).toContain(
      "add http://192.168.0.58:4716 to backend_allowed_origins (comma-separated) in its config.yaml"
    );
    expect(title).toContain(
      "On another device, 127.0.0.1 is that device itself"
    );
    expect(title).toContain("Restart the backend after these changes");
  });

  it("treats an AbortError it did not cause as a rejected request", async () => {
    stubFetch(() =>
      Promise.reject(new DOMException("Aborted elsewhere.", "AbortError"))
    );
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    expect(
      await screen.findByRole("button", { name: /from this page/ })
    ).toBeTruthy();
  });

  it("keeps the plain tooltip when its own timeout fires", async () => {
    vi.useFakeTimers();
    stubFetch(
      (init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          )
        )
    );
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(screen.getByRole("button", { name: PLAIN })).toBeTruthy();
  });

  it("keeps the plain tooltip after an HTTP error", async () => {
    stubFetch(() => Promise.resolve(new Response("busy", { status: 503 })));
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    expect(await screen.findByRole("button", { name: PLAIN })).toBeTruthy();
  });

  it("offers to reconnect to the backend port on this page's host when it answers", async () => {
    const fetchMock = stubFetch(rejected, {
      "http://192.168.0.58:6174/info": answers,
    });
    const onReconnect = vi.fn();
    render(
      <HealthIndicator
        deploymentUrl={BACKEND}
        onReconnect={onReconnect}
      />
    );
    const reconnect = await screen.findByRole("button", {
      name: "Reconnect to detected backend http://192.168.0.58:6174",
    });
    reconnect.click();
    expect(onReconnect).toHaveBeenCalledWith("http://192.168.0.58:6174");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.0.58:6174/info",
      expect.anything()
    );
  });

  it("tells the user to reconnect when this page's host answers", async () => {
    stubFetch(rejected, { "http://192.168.0.58:6174/info": answers });
    render(
      <HealthIndicator
        deploymentUrl={BACKEND}
        onReconnect={() => {}}
      />
    );
    expect(
      await screen.findByRole("button", {
        name: `Can't reach the backend at ${BACKEND}, but one answers at http://192.168.0.58:6174: use Reconnect. Click to retry.`,
      })
    ).toBeTruthy();
  });

  const SETTINGS_HINT =
    "but one answers at http://192.168.0.58:6174: enter it as the Deployment URL in Settings";
  const titleOf = () =>
    screen
      .getByRole("button", { name: /Can't reach the backend/ })
      .getAttribute("title") ?? "";

  it("gives the address for Settings when there is no Reconnect button", async () => {
    stubFetch(rejected, { "http://192.168.0.58:6174/info": answers });
    // No onReconnect: the light shows no Reconnect button.
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    await waitFor(() => expect(titleOf()).toContain(SETTINGS_HINT));
    expect(screen.queryByRole("button", { name: /^Reconnect/ })).toBeNull();
  });

  // A window of the given width: matchMedia answers min-width queries for it,
  // and the returned function resizes it as a browser would.
  function stubWidth(width: number) {
    const listeners = new Set<() => void>();
    let current = width;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((media: string) => {
        const min = Number(/min-width:\s*(\d+)px/.exec(media)?.[1] ?? 0);
        const query = {
          get matches() {
            return current >= min;
          },
          addEventListener: (_: string, l: () => void) => listeners.add(l),
          removeEventListener: (_: string, l: () => void) =>
            listeners.delete(l),
        };
        return query;
      }),
    });
    return (next: number) => {
      current = next;
      act(() => listeners.forEach((l) => l()));
    };
  }
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("offers no Reconnect on a phone, where the header has no room for it", async () => {
    stubWidth(419);
    stubFetch(rejected, { "http://192.168.0.58:6174/info": answers });
    render(
      <HealthIndicator
        deploymentUrl={BACKEND}
        onReconnect={() => {}}
      />
    );
    await waitFor(() => expect(titleOf()).toContain(SETTINGS_HINT));
    expect(screen.queryByRole("button", { name: /^Reconnect/ })).toBeNull();
  });

  it("follows the window across the phone width", async () => {
    const resize = stubWidth(420);
    stubFetch(rejected, { "http://192.168.0.58:6174/info": answers });
    render(
      <HealthIndicator
        deploymentUrl={BACKEND}
        onReconnect={() => {}}
      />
    );
    expect(
      await screen.findByRole("button", {
        name: "Reconnect to detected backend http://192.168.0.58:6174",
      })
    ).toBeTruthy();
    resize(419);
    expect(screen.queryByRole("button", { name: /^Reconnect/ })).toBeNull();
    expect(titleOf()).toContain(SETTINGS_HINT);
    resize(1024);
    expect(
      screen.getByRole("button", {
        name: "Reconnect to detected backend http://192.168.0.58:6174",
      })
    ).toBeTruthy();
  });

  // A saved URL on a port the backend no longer uses.
  const SAVED = "http://127.0.0.1:6199";
  function stubCandidates(pageHost: () => Promise<Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u === `${SAVED}/info`) return rejected();
        if (u === "http://192.168.0.58:6174/info") return pageHost();
        if (u === `${BACKEND}/info`) return answers();
        return new Response(
          JSON.stringify({ port: 6174, deploymentUrl: BACKEND })
        );
      })
    );
  }

  it("prefers the backend port on this page's host, since loopback may be this device", async () => {
    stubCandidates(answers);
    render(
      <HealthIndicator
        deploymentUrl={SAVED}
        onReconnect={() => {}}
      />
    );
    expect(
      await screen.findByRole("button", {
        name: "Reconnect to detected backend http://192.168.0.58:6174",
      })
    ).toBeTruthy();
  });

  it("falls back to the configured loopback address when this page's host does not answer", async () => {
    stubCandidates(rejected);
    render(
      <HealthIndicator
        deploymentUrl={SAVED}
        onReconnect={() => {}}
      />
    );
    expect(
      await screen.findByRole("button", {
        name: `Reconnect to detected backend ${BACKEND}`,
      })
    ).toBeTruthy();
  });

  it("still says connected when the backend accepts the page", async () => {
    stubFetch(answers);
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Connected to http://127.0.0.1:6174 · langgraph 0.15.1",
        })
      ).toBeTruthy()
    );
  });
});
