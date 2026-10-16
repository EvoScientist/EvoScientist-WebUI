// @vitest-environment jsdom
//
// The health light on a page opened on localhost (jsdom's default URL).
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
