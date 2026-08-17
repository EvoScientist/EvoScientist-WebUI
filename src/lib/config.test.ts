// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getConfig, isLoopbackDeployment } from "./config";

describe("isLoopbackDeployment", () => {
  it.each([
    "http://localhost:6174",
    "http://127.0.0.1:6174",
    "http://127.1.2.3:6174",
    "http://0.0.0.0:6174",
    "http://[::1]:6174",
  ])("recognizes %s as local", (deploymentUrl) => {
    expect(isLoopbackDeployment(deploymentUrl)).toBe(true);
  });

  it("does not classify remote deployments as local", () => {
    expect(isLoopbackDeployment("https://example.langgraph.app")).toBe(false);
  });
});

describe("getConfig", () => {
  beforeEach(() => localStorage.clear());

  it("drops legacy LangSmith credentials for a local deployment", () => {
    localStorage.setItem(
      "evoscientist-config",
      JSON.stringify({
        deploymentUrl: "http://127.0.0.1:6174",
        assistantId: "old-assistant",
        langsmithApiKey: "legacy-key",
      })
    );

    expect(getConfig()).toEqual({
      deploymentUrl: "http://127.0.0.1:6174",
      assistantId: "EvoScientist",
    });
  });

  it("preserves LangSmith credentials for a remote deployment", () => {
    localStorage.setItem(
      "evoscientist-config",
      JSON.stringify({
        deploymentUrl: "https://example.langgraph.app",
        assistantId: "old-assistant",
        langsmithApiKey: "remote-key",
      })
    );

    expect(getConfig()).toEqual({
      deploymentUrl: "https://example.langgraph.app",
      assistantId: "EvoScientist",
      langsmithApiKey: "remote-key",
    });
  });
});
