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
