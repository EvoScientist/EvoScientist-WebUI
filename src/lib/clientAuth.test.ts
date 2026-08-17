import { describe, expect, it } from "vitest";
import { buildClientHeaders, buildClientOptions } from "./clientAuth";

describe("buildClientHeaders", () => {
  it("omits X-Api-Key when no explicit credential is configured", () => {
    expect(buildClientHeaders("")).toEqual({
      "Content-Type": "application/json",
    });
    expect(buildClientHeaders("   ")).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("trims and includes an explicit API key", () => {
    expect(buildClientHeaders(" remote-key ")).toEqual({
      "Content-Type": "application/json",
      "X-Api-Key": "remote-key",
    });
  });
});

describe("buildClientOptions", () => {
  it("disables the SDK's environment-variable API-key fallback", () => {
    expect(buildClientOptions("http://127.0.0.1:6174", "")).toMatchObject({
      apiUrl: "http://127.0.0.1:6174",
      apiKey: null,
      defaultHeaders: { "Content-Type": "application/json" },
    });
  });
});
