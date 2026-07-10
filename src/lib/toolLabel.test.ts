import { describe, expect, it } from "vitest";
import { formatToolLabel } from "./toolLabel";

describe("formatToolLabel", () => {
  it("returns 'Unknown Tool' when name is empty", () => {
    expect(formatToolLabel("")).toBe("Unknown Tool");
  });

  it("maps the tool-selector's internal response name", () => {
    expect(formatToolLabel("ToolSelectionResponse")).toBe(
      "Adaptive tool selection"
    );
  });

  it("maps think_tool to Reflection (case-insensitive)", () => {
    expect(formatToolLabel("think_tool")).toBe("Reflection");
    expect(formatToolLabel("THINK_TOOL")).toBe("Reflection");
  });

  it("relabels memory reads and writes based on `path`", () => {
    expect(formatToolLabel("read_file", { path: "/memories/notes.md" })).toBe(
      "Reading memory"
    );
    expect(formatToolLabel("write_file", { path: "/memories/notes.md" })).toBe(
      "Updating memory"
    );
    expect(formatToolLabel("edit_file", { path: "/memories/notes.md" })).toBe(
      "Updating memory"
    );
  });

  it("relabels memory tools when path is passed as file_path", () => {
    expect(
      formatToolLabel("read_file", { file_path: "/memories/notes.md" })
    ).toBe("Reading memory");
  });

  it("labels /skills/<name>/... reads as 'Skill: <name>'", () => {
    expect(
      formatToolLabel("read_file", { path: "/skills/init/SKILL.md" })
    ).toBe("Skill: init");
  });

  it("does not use skill label for non-read file tools", () => {
    expect(
      formatToolLabel("write_file", { path: "/skills/init/SKILL.md" })
    ).toBe("write_file");
  });

  it("ignores empty first path segment in /skills//x", () => {
    expect(formatToolLabel("read_file", { path: "/skills//x" })).toBe(
      "read_file"
    );
  });

  it("accepts args passed as a JSON string", () => {
    expect(
      formatToolLabel("read_file", JSON.stringify({ path: "/memories/x" }))
    ).toBe("Reading memory");
  });

  it("treats non-parseable string args as empty (streaming partial)", () => {
    expect(formatToolLabel("read_file", '{"path": "/memori')).toBe("read_file");
  });

  it("falls through to the raw name for any other tool", () => {
    expect(formatToolLabel("execute", { command: "ls" })).toBe("execute");
  });
});
