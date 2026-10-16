import { describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  offlineTitle,
  pageHostBackendUrl,
} from "./backendBoundary";

const page = (url: string) => {
  const u = new URL(url);
  return {
    origin: u.origin,
    hostname: u.hostname,
    port: u.port,
    protocol: u.protocol,
  };
};
const PLAIN = (backend: string) =>
  `Can't reach the backend at ${backend}. Is "EvoSci deploy" running? Click to retry.`;
const LOG =
  '; its log (~/.config/evoscientist/langgraph_dev.log) then shows "Refused a request" with the fix. Click to retry.';

describe("isLoopbackHost", () => {
  it("trusts exactly the backend's loopback names, on any port", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "LOCALHOST"])
      expect(isLoopbackHost(host)).toBe(true);
  });

  it("does not trust other names, other loopback addresses or the wildcard", () => {
    for (const host of [
      "192.168.0.58",
      "my-mac.local",
      "evosci.example.com",
      "127.0.0.2",
      "0.0.0.0",
      "foo.localhost",
      "localhost.",
      "",
    ])
      expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("offlineTitle", () => {
  const local = "http://127.0.0.1:6174";
  const localhostPage = page("http://localhost:4716/");
  const lanPage = page("http://192.168.0.58:4716/");

  it("keeps the plain hint where nothing can be refused", () => {
    expect(offlineTitle(local, localhostPage, "network")).toBe(PLAIN(local));
    expect(offlineTitle("http://[::1]:6174", localhostPage, "network")).toBe(
      PLAIN("http://[::1]:6174")
    );
    // The backend trusts its own quick tunnel's name.
    const tunnel = "https://quiet-lake-1234.trycloudflare.com";
    expect(offlineTitle(tunnel, localhostPage, "network")).toBe(PLAIN(tunnel));
    // No window (server rendering).
    expect(offlineTitle(local, null, "network")).toBe(PLAIN(local));
  });

  it("keeps the plain hint for failures a refusal cannot cause", () => {
    // A readable HTTP error passed CORS, so the backend accepted the page;
    // the boundary answers at once, so a timeout is not a refusal either.
    for (const cause of ["http", "timeout", null] as const)
      expect(offlineTitle(local, lanPage, cause)).toBe(PLAIN(local));
  });

  it("keeps the plain hint for a URL fetch cannot send", () => {
    // `new URL` accepts "localhost:6174" with the scheme "localhost:".
    expect(offlineTitle("localhost:6174", lanPage, "network")).toBe(
      PLAIN("localhost:6174")
    );
    for (const url of [
      "ws://127.0.0.1:6174",
      "http://user:pass@127.0.0.1:6174",
      "http://user@127.0.0.1:6174",
      "http://:pass@127.0.0.1:6174",
    ])
      expect(offlineTitle(url, lanPage, "network")).toBe(PLAIN(url));
    expect(offlineTitle("not a url", lanPage, "network")).toBe(
      PLAIN("not a url")
    );
  });

  it("gives the remedies that hold on the backend's machine and on another device", () => {
    expect(offlineTitle(local, lanPage, "network")).toBe(
      "Can't reach the backend at http://127.0.0.1:6174 from this page, http://192.168.0.58:4716. " +
        "If it is running, it refuses pages it does not trust: add http://192.168.0.58:4716 to " +
        "backend_allowed_origins (comma-separated) in its config.yaml. " +
        "On another device, 127.0.0.1 is that device itself, so also run " +
        "`EvoSci config set langgraph_dev_host 0.0.0.0` on the backend's machine. " +
        "Restart the backend after these changes; on another device, then use Reconnect here once it appears " +
        "or enter the backend machine's address in Settings. " +
        "On the backend's machine, opening the WebUI on localhost usually works without any " +
        "change. Click to retry."
    );
  });

  it("sends the user to Reconnect once a backend answers elsewhere", () => {
    for (const p of [lanPage, localhostPage]) {
      expect(
        offlineTitle(local, p, "network", "http://192.168.0.58:6174")
      ).toBe(
        "Can't reach the backend at http://127.0.0.1:6174, but one answers at " +
          "http://192.168.0.58:6174: use Reconnect. Click to retry."
      );
    }
    // Also after a timeout or an HTTP error: a backend answers there either way.
    expect(
      offlineTitle(local, lanPage, "http", "http://127.0.0.1:6175")
    ).toContain("but one answers at http://127.0.0.1:6175: use Reconnect");
    // A saved backend on the page's own host is on hand too.
    expect(
      offlineTitle("http://192.168.0.58:6199", lanPage, "network", local)
    ).toContain(`but one answers at ${local}: use Reconnect`);
  });

  it("gives the address for Settings when the light has no Reconnect button", () => {
    expect(
      offlineTitle(local, lanPage, "network", "http://192.168.0.58:6174", false)
    ).toBe(
      "Can't reach the backend at http://127.0.0.1:6174, but one answers at " +
        "http://192.168.0.58:6174: enter it as the Deployment URL in Settings. Click to retry."
    );
    const steps = offlineTitle(local, lanPage, "network", null, false);
    expect(steps).toContain(
      "on another device, then enter the backend machine's address in Settings."
    );
    expect(steps).not.toContain("Reconnect");
  });

  it("adds an address that answers when there is no Reconnect button to offer it", () => {
    const remote = offlineTitle(
      "http://lab-server:6199",
      lanPage,
      "network",
      "http://192.168.0.58:6174",
      false
    );
    expect(remote).toContain("its log");
    expect(remote).toContain(
      "A backend answers at http://192.168.0.58:6174; enter it as the Deployment URL in Settings to use it. Click to retry."
    );
    // The plain hint gets it too.
    expect(
      offlineTitle(
        "http://lab-server:6199",
        localhostPage,
        "http",
        "http://127.0.0.1:6174",
        false
      )
    ).toBe(
      'Can\'t reach the backend at http://lab-server:6199. Is "EvoSci deploy" running? ' +
        "A backend answers at http://127.0.0.1:6174; enter it as the Deployment URL in Settings " +
        "to use it. Click to retry."
    );
    // With a button, the button offers it.
    expect(
      offlineTitle(
        "http://lab-server:6199",
        lanPage,
        "network",
        "http://192.168.0.58:6174",
        true
      )
    ).not.toContain("A backend answers at");
  });

  it("keeps explaining a backend the user picked elsewhere, even when Reconnect is offered", () => {
    expect(
      offlineTitle("http://lab-server:6174", localhostPage, "network", local)
    ).toBe(
      "Can't reach the backend at http://lab-server:6174. If it is running, it may be refusing " +
        "requests addressed to lab-server" +
        LOG
    );
  });

  it("names the page's own origin, by name or IPv6 address, without inventing a localhost URL", () => {
    for (const url of [
      "http://my-mac.local:4716/",
      "https://evosci.example.com/",
      "http://[fe80::1]:4716/",
    ]) {
      const p = page(url);
      const text = offlineTitle(local, p, "network");
      expect(text).toContain(`add ${p.origin} to backend_allowed_origins`);
      expect(text).not.toMatch(/https?:\/\/localhost/);
    }
  });

  it("points at the backend log when the backend is reached by any other name", () => {
    expect(
      offlineTitle("http://lab-server:6174", localhostPage, "network")
    ).toBe(
      "Can't reach the backend at http://lab-server:6174. If it is running, it may be refusing " +
        "requests addressed to lab-server" +
        LOG
    );
    // An address can be refused too, as the host's address of a container.
    expect(
      offlineTitle("http://192.168.0.58:6174", localhostPage, "network")
    ).toContain("may be refusing requests addressed to 192.168.0.58;");
    expect(
      offlineTitle("http://192.168.0.58:6174", lanPage, "network")
    ).toContain(
      "may be refusing requests addressed to 192.168.0.58 or from pages on http://192.168.0.58:4716;"
    );
    expect(
      offlineTitle(
        "https://api.example.com",
        page("https://ui.example.com/"),
        "network"
      )
    ).toContain(
      "may be refusing requests addressed to api.example.com or from pages on https://ui.example.com;"
    );
  });

  it("points at the backend log for a page off localhost and a quick tunnel", () => {
    expect(
      offlineTitle(
        "https://quiet-lake-1234.trycloudflare.com",
        lanPage,
        "network"
      )
    ).toBe(
      "Can't reach the backend at https://quiet-lake-1234.trycloudflare.com. If it is running, " +
        "it may be refusing pages on http://192.168.0.58:4716" +
        LOG
    );
  });
});

describe("pageHostBackendUrl", () => {
  it("offers the backend port on the page's own host for a page off localhost", () => {
    expect(pageHostBackendUrl(page("http://192.168.0.58:4716/"), 6174)).toBe(
      "http://192.168.0.58:6174"
    );
    // An https page can only reach an https backend.
    expect(pageHostBackendUrl(page("https://my-mac.local/"), 6174)).toBe(
      "https://my-mac.local:6174"
    );
    expect(pageHostBackendUrl(page("http://[fe80::1]:4716/"), 6174)).toBe(
      "http://[fe80::1]:6174"
    );
  });

  it("offers nothing for a localhost page or without a port", () => {
    expect(pageHostBackendUrl(page("http://localhost:4716/"), 6174)).toBeNull();
    expect(
      pageHostBackendUrl(page("http://192.168.0.58:4716/"), null)
    ).toBeNull();
    expect(pageHostBackendUrl(null, 6174)).toBeNull();
  });
});
