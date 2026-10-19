import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@langchain/langgraph-sdk";

import {
  ensureWorkspaceAssistant,
  fetchServedWorkspace,
  folderName,
  workspaceAssistantId,
} from "./workspaceAssistant";

afterEach(() => vi.unstubAllGlobals());

describe("workspaceAssistantId", () => {
  // Computed with Python's uuid.uuid5, which the core uses.
  it.each([
    ["EvoScientist", "/home/you/projA", "39dcbcc1-957e-51c1-8e52-c294d4031162"],
    ["scheduler", "/home/you/projA", "d36e3f1a-02c5-5639-92a2-d1faaafb1ded"],
    ["EvoScientist", "/home/x/項目 ü", "1e3a647f-1680-5062-9dee-bee0f8a024aa"],
    [
      "EvoScientist",
      "C:/Users/me/proj",
      "67401d58-7465-5142-a717-d81c29157a15",
    ],
  ])("matches the core's ID for %s in %s", (graphId, key, expected) => {
    expect(workspaceAssistantId(graphId, key)).toBe(expected);
  });
});

describe("folderName", () => {
  it("returns the last segment of a key", () => {
    expect(folderName("/home/you/projA")).toBe("projA");
    expect(folderName("C:/Users/me/proj")).toBe("proj");
  });
});

describe("ensureWorkspaceAssistant", () => {
  it("creates the folder's assistant under its computed ID, keeping an existing one", async () => {
    const create = vi.fn().mockResolvedValue({ assistant_id: "x" });
    const client = { assistants: { create } } as unknown as Client;

    await ensureWorkspaceAssistant(client, "EvoScientist", "/home/you/projA");

    expect(create).toHaveBeenCalledWith({
      graphId: "EvoScientist",
      assistantId: "39dcbcc1-957e-51c1-8e52-c294d4031162",
      ifExists: "do_nothing",
      config: { configurable: { workspace_dir: "/home/you/projA" } },
      metadata: { workspace_dir: "/home/you/projA" },
      name: "EvoScientist · projA",
    });
  });
});

describe("fetchServedWorkspace", () => {
  function stubFetch(status: number, body: unknown = {}) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads the served folder and run folder", async () => {
    const fetchMock = stubFetch(200, {
      workspace_dir: "/home/you/projA",
      run_dir: "/home/you/projA/runs/r1",
    });

    await expect(
      fetchServedWorkspace("http://127.0.0.1:6174/", "k")
    ).resolves.toEqual({
      key: "/home/you/projA",
      runDir: "/home/you/projA/runs/r1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:6174/api/workspace",
      { headers: { "X-Api-Key": "k" }, cache: "no-store" }
    );
  });

  it("returns null for a core without the route", async () => {
    stubFetch(404);
    await expect(
      fetchServedWorkspace("http://127.0.0.1:6174", "")
    ).resolves.toBeNull();
  });

  it("throws when the backend fails, so the caller retries", async () => {
    stubFetch(503);
    await expect(
      fetchServedWorkspace("http://127.0.0.1:6174", "")
    ).rejects.toThrow("HTTP 503");
  });
});
