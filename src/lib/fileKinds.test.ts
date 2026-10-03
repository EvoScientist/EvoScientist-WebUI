import { describe, expect, it } from "vitest";
import { extOf, fileKindOf, fileNameOf, workspaceFileUrl } from "./fileKinds";
import { stateFileText } from "./stateFiles";

describe("fileKinds", () => {
  it("names and extensions", () => {
    expect(fileNameOf("outputs/report.MD")).toBe("report.MD");
    expect(fileNameOf("/memories/notes/")).toBe("notes");
    expect(extOf("report.MD")).toBe("md");
    expect(extOf("Makefile")).toBe("");
  });

  it("kinds keep the workspace dialog's text list", () => {
    expect(fileKindOf("md")).toBe("text");
    expect(fileKindOf("csv")).toBe("text");
    expect(fileKindOf("png")).toBe("image");
    expect(fileKindOf("pdf")).toBe("pdf");
    expect(fileKindOf("scala")).toBe("binary");
    expect(fileKindOf("")).toBe("binary");
  });

  it("builds the file API URL", () => {
    expect(workspaceFileUrl("a b/c.md")).toBe(
      "/api/workspace/file?path=a+b%2Fc.md"
    );
    expect(workspaceFileUrl("c.pdf", { download: true, version: 2 })).toBe(
      "/api/workspace/file?path=c.pdf&download=1&v=2"
    );
  });
});

describe("stateFileText", () => {
  it("reads strings and the { content: [...] } shape", () => {
    expect(stateFileText("hi")).toBe("hi");
    expect(stateFileText({ content: ["a", "b"] })).toBe("a\nb");
    expect(stateFileText({ content: "x" })).toBe("x");
    expect(stateFileText(undefined)).toBe("");
  });
});
