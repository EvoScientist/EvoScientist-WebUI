import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isCrossOrigin } from "@/lib/server/workspace";

// The first NextRequest argument is the server's own view of the URL. In the
// standalone server that origin comes from the configured HOSTNAME (not the
// address in the browser), so building requests on http://0.0.0.0:4716 while
// the Host header says localhost reproduces the #35 production mismatch.
function req(headers: Record<string, string>) {
  return new NextRequest("http://0.0.0.0:4716/api/workspace/upload", {
    method: "POST",
    headers,
  });
}

describe("isCrossOrigin", () => {
  it("allows same-origin writes when nextUrl is pinned to a wildcard HOSTNAME (#35)", () => {
    expect(
      isCrossOrigin(
        req({ host: "localhost:4716", origin: "http://localhost:4716" })
      )
    ).toBe(false);
  });

  it("allows LAN visitors whose Origin matches the Host they connected to", () => {
    expect(
      isCrossOrigin(
        req({ host: "192.168.1.10:4716", origin: "http://192.168.1.10:4716" })
      )
    ).toBe(false);
  });

  it("trusts Sec-Fetch-Site: same-origin without consulting Origin", () => {
    expect(
      isCrossOrigin(
        req({
          "sec-fetch-site": "same-origin",
          host: "localhost:4716",
          origin: "http://localhost:4716",
        })
      )
    ).toBe(false);
  });

  it.each(["same-site", "none"])("allows Sec-Fetch-Site: %s", (site) => {
    expect(isCrossOrigin(req({ "sec-fetch-site": site }))).toBe(false);
  });

  it("rejects Sec-Fetch-Site: cross-site even when Origin matches Host", () => {
    expect(
      isCrossOrigin(
        req({
          "sec-fetch-site": "cross-site",
          host: "localhost:4716",
          origin: "http://localhost:4716",
        })
      )
    ).toBe(true);
  });

  it("rejects an Origin whose host differs from the request Host", () => {
    expect(
      isCrossOrigin(
        req({ host: "localhost:4716", origin: "http://evil.example" })
      )
    ).toBe(true);
  });

  it("allows requests with neither Sec-Fetch-Site nor Origin", () => {
    expect(isCrossOrigin(req({ host: "localhost:4716" }))).toBe(false);
  });

  it("rejects an opaque or malformed Origin", () => {
    expect(isCrossOrigin(req({ host: "localhost:4716", origin: "null" }))).toBe(
      true
    );
  });
});
