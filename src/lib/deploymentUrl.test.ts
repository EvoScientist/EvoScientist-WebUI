import { describe, expect, it } from "vitest";
import { deploymentUrlError, sameDeploymentUrl } from "./deploymentUrl";

describe("deploymentUrlError", () => {
  it.each(["", "   "])("asks for an address when it is blank (%j)", (input) => {
    expect(deploymentUrlError(input)).toBe(
      "Enter your deployment URL to continue."
    );
  });

  it("refuses text that is not a URL", () => {
    expect(deploymentUrlError("not a url")).toBe(
      "Enter a valid URL, e.g. http://127.0.0.1:6174"
    );
  });

  it("accepts a URL with spaces around it", () => {
    expect(deploymentUrlError(" http://127.0.0.1:6174 ")).toBeNull();
  });

  // Guards: still accepted after the scheme check.
  it.each([
    "HTTP://127.0.0.1:6174",
    "http://[::1]:6174",
    "https://x.example/evo",
  ])("still accepts %s", (input) => {
    expect(deploymentUrlError(input)).toBeNull();
  });

  // These parse with an http(s) protocol, but fetch resolves the slash-less
  // forms against the page's own address (where requests land depends on the
  // page) and refuses URLs with credentials outright.
  it.each([
    "http:/127.0.0.1:6174",
    "http:127.0.0.1:6174",
    "https:example.com",
    "http://user:pass@127.0.0.1:6174",
    "http://user@127.0.0.1:6174",
    "http://:pass@127.0.0.1:6174",
  ])("refuses %s, which fetch cannot use as typed", (input) => {
    expect(deploymentUrlError(input)).toBe(
      "Enter a valid URL, e.g. http://127.0.0.1:6174"
    );
  });

  // Callers append the API path to the string ("${base}/api/models"), so a
  // query or fragment would swallow it: "/x?q=1/api/models" never reaches the API.
  it.each([
    "https://x.example/?q=1",
    "http://127.0.0.1:6174/#top",
    "http://127.0.0.1:6174?",
  ])(
    "refuses %s, whose query or fragment would swallow the API path",
    (input) => {
      expect(deploymentUrlError(input)).toBe(
        "Enter a valid URL, e.g. http://127.0.0.1:6174"
      );
    }
  );

  // A bare address never parses as a URL (a scheme cannot start with a digit).
  it("refuses an address without a scheme", () => {
    expect(deploymentUrlError("127.0.0.1:6174")).toBe(
      "Enter a valid URL, e.g. http://127.0.0.1:6174"
    );
  });

  it("accepts an https address, such as a tunnel's", () => {
    expect(deploymentUrlError("https://example.trycloudflare.com")).toBeNull();
  });

  // `new URL` takes any scheme: "localhost:6174" parses with the protocol
  // "localhost:". The SDK and fetch can only use http(s).
  it.each([
    "localhost:6174",
    "view-source:http://127.0.0.1:6174",
    "javascript:alert(1)",
    "file:///etc/hosts",
    "ftp://example.com",
  ])("refuses %s, which is not http or https", (input) => {
    expect(deploymentUrlError(input)).toBe(
      "Enter a valid URL, e.g. http://127.0.0.1:6174"
    );
  });
});

describe("sameDeploymentUrl", () => {
  it("ignores outer spaces and one trailing slash", () => {
    expect(
      sameDeploymentUrl("http://127.0.0.1:6174/", " http://127.0.0.1:6174")
    ).toBe(true);
  });

  it("tells another port apart", () => {
    expect(
      sameDeploymentUrl("http://127.0.0.1:6174", "http://127.0.0.1:7000")
    ).toBe(false);
  });
});
