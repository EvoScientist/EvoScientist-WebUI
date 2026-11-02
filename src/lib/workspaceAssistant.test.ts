import { describe, expect, it } from "vitest";

import { folderName, workspaceAssistantId } from "./workspaceAssistant";

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
