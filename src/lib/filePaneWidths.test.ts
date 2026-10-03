// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clampInspectorWidth,
  DEFAULT_PANE_WIDTHS,
  readPaneWidths,
  savePaneWidth,
} from "./filePaneWidths";

beforeEach(() => window.localStorage.clear());

describe("filePaneWidths", () => {
  it("defaults, then remembers each mode on its own", () => {
    expect(readPaneWidths()).toEqual(DEFAULT_PANE_WIDTHS);
    savePaneWidth("preview", 55);
    expect(readPaneWidths()).toEqual({ tree: 26, preview: 55 });
  });

  it("ignores garbage and out-of-range values", () => {
    window.localStorage.setItem("evoscientist-file-pane-widths", "{nope");
    expect(readPaneWidths()).toEqual(DEFAULT_PANE_WIDTHS);
    window.localStorage.setItem(
      "evoscientist-file-pane-widths",
      JSON.stringify({ tree: 5, preview: "x" })
    );
    expect(readPaneWidths()).toEqual(DEFAULT_PANE_WIDTHS);
    savePaneWidth("tree", 99);
    expect(readPaneWidths().tree).toBe(26);
  });

  it("keeps room for the chat column", () => {
    expect(clampInspectorWidth(45, 1600, 0)).toBe(45);
    // 360px of 1000px is 36%: at most 64% for the inspector.
    expect(clampInspectorWidth(80, 1000, 0)).toBe(64);
    // An open thread sidebar takes its share too.
    expect(clampInspectorWidth(80, 1000, 23)).toBe(41);
    // Never below the panel's own minimum.
    expect(clampInspectorWidth(45, 500, 23)).toBe(20);
  });
});
