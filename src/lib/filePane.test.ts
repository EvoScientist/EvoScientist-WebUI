import { describe, expect, it } from "vitest";
import {
  filePaneReducer,
  fileTabId,
  initialFilePaneState,
  MAX_TABS,
  parseFileParam,
  type FilePaneAction,
  type FilePaneState,
} from "./filePane";

const run = (...actions: FilePaneAction[]): FilePaneState =>
  actions.reduce(filePaneReducer, initialFilePaneState);
const ws = (path: string, size?: number): FilePaneAction => ({
  type: "open",
  ref: { source: "workspace", path, size },
});
const ids = (s: FilePaneState) => s.tabs.map((t) => t.id);
const manyTabs = () => Array.from({ length: MAX_TABS }, (_, i) => ws(`f${i}`));

describe("filePaneReducer", () => {
  it("opens a file as the shown tab", () => {
    const s = run(ws("a.md"));
    expect(ids(s)).toEqual(["workspace:a.md"]);
    expect(s.activeId).toBe("workspace:a.md");
    expect(s.mode).toBe("preview");
  });

  it("switches to an already open file instead of opening it twice", () => {
    const s = run(ws("a.md"), ws("b.md"), ws("a.md"));
    expect(ids(s)).toEqual(["workspace:a.md", "workspace:b.md"]);
    expect(s.activeId).toBe("workspace:a.md");
  });

  it("tells the same path from different sources apart", () => {
    const s = run(ws("a.md"), {
      type: "open",
      ref: { source: "memory", path: "a.md" },
    });
    expect(ids(s)).toEqual(["workspace:a.md", "memory:a.md"]);
  });

  it("keeps a re-opened file's unsaved state", () => {
    const s = run(
      ws("a.md"),
      { type: "setDirty", id: "workspace:a.md", dirty: true },
      ws("b.md"),
      ws("a.md")
    );
    expect(s.tabs[0].dirty).toBe(true);
  });

  it("updates the size when an opener knows it", () => {
    expect(run(ws("a.md"), ws("a.md", 42)).tabs[0].size).toBe(42);
  });

  it("shows the next tab after closing the shown one", () => {
    const s = run(
      ws("a"),
      ws("b"),
      ws("c"),
      { type: "activate", id: "workspace:b" },
      { type: "close", id: "workspace:b" }
    );
    expect(ids(s)).toEqual(["workspace:a", "workspace:c"]);
    expect(s.activeId).toBe("workspace:c");
    expect(s.mode).toBe("preview");
  });

  it("shows the previous tab after closing the last one in the row", () => {
    const s = run(ws("a"), ws("b"), { type: "close", id: "workspace:b" });
    expect(s.activeId).toBe("workspace:a");
  });

  it("goes back to the tree when the last tab closes", () => {
    const s = run(ws("a"), { type: "close", id: "workspace:a" });
    expect(s.tabs).toEqual([]);
    expect(s.activeId).toBeNull();
    expect(s.mode).toBe("tree");
  });

  it("leaves the shown tab alone when closing another", () => {
    const s = run(ws("a"), ws("b"), { type: "close", id: "workspace:a" });
    expect(s.activeId).toBe("workspace:b");
  });

  it(`evicts the longest-unseen tab past ${MAX_TABS}`, () => {
    const s = run(
      ...manyTabs(),
      { type: "activate", id: "workspace:f0" },
      ws("new")
    );
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(ids(s)).not.toContain("workspace:f1");
    expect(ids(s)).toContain("workspace:f0");
    expect(s.activeId).toBe("workspace:new");
  });

  it("never evicts a tab with unsaved edits", () => {
    const s = run(
      ...manyTabs(),
      { type: "setDirty", id: "workspace:f0", dirty: true },
      ws("new")
    );
    expect(ids(s)).toContain("workspace:f0");
    expect(ids(s)).not.toContain("workspace:f1");
  });

  it("goes past the limit rather than drop unsaved edits", () => {
    const dirtyAll = manyTabs().map(
      (_, i): FilePaneAction => ({
        type: "setDirty",
        id: `workspace:f${i}`,
        dirty: true,
      })
    );
    expect(run(...manyTabs(), ...dirtyAll, ws("new")).tabs).toHaveLength(
      MAX_TABS + 1
    );
  });

  it("closes every tab of a source, unsaved or not", () => {
    const s = run(
      ws("a"),
      { type: "open", ref: { source: "state", path: "notes.md" } },
      { type: "setDirty", id: "state:notes.md", dirty: true },
      ws("b"),
      { type: "activate", id: "state:notes.md" },
      { type: "closeSource", source: "state" }
    );
    expect(ids(s)).toEqual(["workspace:a", "workspace:b"]);
    expect(s.activeId).toBe("workspace:b");
  });

  it("returns to the tree when closing a source empties the pane", () => {
    const s = run(
      { type: "open", ref: { source: "state", path: "notes.md" } },
      { type: "closeSource", source: "state" }
    );
    expect(s.activeId).toBeNull();
    expect(s.mode).toBe("tree");
  });

  it("switches between tree and preview without touching tabs", () => {
    let s = run(ws("a"), { type: "showTree" });
    expect(s.mode).toBe("tree");
    expect(s.activeId).toBe("workspace:a");
    s = filePaneReducer(s, { type: "showPreview" });
    expect(s.mode).toBe("preview");
  });

  it("stays on the tree when there is nothing to preview", () => {
    expect(run({ type: "showPreview" }).mode).toBe("tree");
  });

  it("ignores actions on tabs that are not open", () => {
    const s = run(ws("a"));
    expect(filePaneReducer(s, { type: "activate", id: "workspace:z" })).toBe(s);
    expect(filePaneReducer(s, { type: "close", id: "workspace:z" })).toBe(s);
    expect(
      filePaneReducer(s, { type: "setDirty", id: "workspace:z", dirty: true })
    ).toBe(s);
  });
});

describe("file URL param", () => {
  it("round-trips every source", () => {
    for (const source of ["workspace", "memory", "state"] as const) {
      const ref = { source, path: "dir/报告 v2.md" };
      expect(parseFileParam(fileTabId(ref))).toEqual(ref);
    }
  });

  it("keeps colons inside the path", () => {
    expect(parseFileParam("workspace:logs/12:30.txt")).toEqual({
      source: "workspace",
      path: "logs/12:30.txt",
    });
  });

  it("rejects malformed values", () => {
    for (const value of [
      null,
      "",
      "bogus",
      ":a.md",
      "workspace:",
      "workspace:   ",
      "disk:a.md",
      "workspace:a\nb.md",
    ]) {
      expect(parseFileParam(value)).toBeNull();
    }
  });
});
