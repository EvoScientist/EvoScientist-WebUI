// @vitest-environment jsdom
//
// The health light on a page opened on localhost (jsdom's default URL).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HealthIndicator } from "./HealthIndicator";

const BACKEND = "http://127.0.0.1:6174";

function stubBackend(info: "up" | "down") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/info")) {
        if (info === "down") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ version: "0.15.1" }));
      }
      // /api/evosci-config: the same, dead URL, so no Reconnect is offered.
      return new Response(
        JSON.stringify({ port: 6174, deploymentUrl: BACKEND })
      );
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HealthIndicator on a localhost page", () => {
  it("asks whether the backend runs when it cannot be reached", async () => {
    stubBackend("down");
    render(<HealthIndicator deploymentUrl={BACKEND} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: 'Can\'t reach the backend at http://127.0.0.1:6174. Is "EvoSci deploy" running? Click to retry.',
        })
      ).toBeTruthy()
    );
  });

  it("does not try the backend port on its own host, which is loopback anyway", async () => {
    stubBackend("down");
    render(
      <HealthIndicator
        deploymentUrl={BACKEND}
        onReconnect={() => {}}
      />
    );
    await screen.findByRole("button", { name: /Is "EvoSci deploy" running\?/ });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toContain(
        "/api/evosci-config"
      )
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/info"))
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
    expect(document.documentElement.hasAttribute("data-reconnect")).toBe(false);
  });

  describe("while it offers Reconnect", () => {
    // The saved URL is dead; the backend now answers on another port.
    const showReconnect = async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (String(url) === `${BACKEND}/info`) {
            throw new TypeError("Failed to fetch");
          }
          if (String(url).endsWith("/info")) {
            return new Response(JSON.stringify({ version: "0.15.1" }));
          }
          return new Response(
            JSON.stringify({
              port: 6190,
              deploymentUrl: "http://127.0.0.1:6190",
            })
          );
        })
      );
      const utils = render(
        <HealthIndicator
          deploymentUrl={BACKEND}
          onReconnect={() => {}}
        />
      );
      const button = await screen.findByRole("button", {
        name: /^Reconnect to detected backend/,
      });
      return { ...utils, button };
    };
    const marked = () =>
      document.documentElement.hasAttribute("data-reconnect");

    it("keeps toasts below the header until the user reconnects", async () => {
      const { button } = await showReconnect();
      // Toasts sit over the middle of the header, where Reconnect can be:
      // globals.css moves them below it while this is set. (The mark comes
      // from an effect, which can land just after the button shows.)
      await waitFor(() => expect(marked()).toBe(true));

      fireEvent.click(button);
      expect(marked()).toBe(false);
    });

    it("drops the mark when it unmounts", async () => {
      const { unmount } = await showReconnect();
      await waitFor(() => expect(marked()).toBe(true));
      unmount();
      expect(marked()).toBe(false);
    });
  });

  it("says connected when /info answers", async () => {
    stubBackend("up");
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
