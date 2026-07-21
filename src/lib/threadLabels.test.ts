import { describe, expect, it } from "vitest";
import {
  buildThreadLabelPatch,
  needsThreadLabelBackfill,
} from "@/lib/threadLabels";

describe("needsThreadLabelBackfill", () => {
  it("returns true when both labels are missing", () => {
    expect(needsThreadLabelBackfill({})).toBe(true);
  });

  it("returns true when metadata is null or undefined", () => {
    expect(needsThreadLabelBackfill(null)).toBe(true);
    expect(needsThreadLabelBackfill(undefined)).toBe(true);
  });

  it("returns false when both labels are present", () => {
    expect(
      needsThreadLabelBackfill({ auto_title: "How do I…", preview: "You can…" })
    ).toBe(false);
  });

  it("returns true when only one label is present", () => {
    expect(needsThreadLabelBackfill({ auto_title: "How do I…" })).toBe(true);
    expect(needsThreadLabelBackfill({ preview: "You can…" })).toBe(true);
  });

  it("treats whitespace-only or non-string labels as missing", () => {
    expect(
      needsThreadLabelBackfill({ auto_title: "  ", preview: "You can…" })
    ).toBe(true);
    expect(
      needsThreadLabelBackfill({ auto_title: 42, preview: "You can…" })
    ).toBe(true);
  });

  it("does not repeat a backfill for an unchanged graph state", () => {
    expect(
      needsThreadLabelBackfill(
        { labels_state_updated_at: "2026-07-21T20:00:00Z" },
        "2026-07-21T20:00:00Z"
      )
    ).toBe(false);
  });

  it("retries a label backfill after the graph state advances", () => {
    expect(
      needsThreadLabelBackfill(
        { labels_state_updated_at: "2026-07-21T20:00:00Z" },
        "2026-07-21T20:05:00Z"
      )
    ).toBe(true);
  });
});

describe("buildThreadLabelPatch", () => {
  it("includes both keys when current metadata has neither", () => {
    expect(
      buildThreadLabelPatch({}, { autoTitle: "Title", preview: "Preview" })
    ).toEqual({ auto_title: "Title", preview: "Preview" });
  });

  it("returns an empty patch when nothing was derived", () => {
    expect(
      buildThreadLabelPatch({}, { autoTitle: null, preview: null })
    ).toEqual({});
  });

  it("omits keys whose value already matches", () => {
    expect(
      buildThreadLabelPatch(
        { auto_title: "Title", preview: "Old" },
        { autoTitle: "Title", preview: "New" }
      )
    ).toEqual({ preview: "New" });
  });

  it("returns an empty patch when both values already match", () => {
    expect(
      buildThreadLabelPatch(
        { auto_title: "Title", preview: "Preview" },
        { autoTitle: "Title", preview: "Preview" }
      )
    ).toEqual({});
  });

  it("never writes a null over an existing value", () => {
    expect(
      buildThreadLabelPatch(
        { auto_title: "Title" },
        { autoTitle: null, preview: null }
      )
    ).toEqual({});
  });

  it("records the graph state even when no labels can be derived", () => {
    expect(
      buildThreadLabelPatch(
        {},
        { autoTitle: null, preview: null },
        "2026-07-21T20:00:00Z"
      )
    ).toEqual({ labels_state_updated_at: "2026-07-21T20:00:00Z" });
  });
});
