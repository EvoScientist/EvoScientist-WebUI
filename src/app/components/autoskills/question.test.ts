// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  fileSection,
  filesQuestion,
  useShownQuestion,
  withFiles,
  type Question,
} from "./question";

const ask = (title: string): Question => ({
  title,
  description: `${title}, said.`,
  action: `${title}, done`,
});

describe("useShownQuestion", () => {
  it("follows the question while open and keeps its words while it fades out", () => {
    const view = renderHook(
      ({ open, live }: { open: boolean; live: Question }) =>
        useShownQuestion(open, live),
      { initialProps: { open: true, live: ask("A") } }
    );
    expect(view.result.current).toEqual(ask("A"));
    view.rerender({ open: true, live: ask("B") });
    expect(view.result.current).toEqual(ask("B"));

    // Closed: the words it had open, whatever changes meanwhile.
    view.rerender({ open: false, live: ask("C") });
    expect(view.result.current).toEqual(ask("B"));
    view.rerender({ open: false, live: ask("D") });
    expect(view.result.current).toEqual(ask("B"));

    // Open again: the question as it is now.
    view.rerender({ open: true, live: ask("E") });
    expect(view.result.current).toEqual(ask("E"));
  });
});

describe("the files an approval installs unseen", () => {
  const big = {
    path: "data/big.csv",
    size: 1_100_000,
    reason: "too_large" as const,
  };
  const png = { path: "logo.png", size: 2048, reason: "not_text" as const };
  const gone = { path: "notes.md", size: 30, reason: "unchecked" as const };

  it("lists one draft's files under its name", () => {
    expect(
      fileSection([{ name: "csv-profiler", files: [big, png, gone] }])
    ).toEqual({
      intro: "csv-profiler holds files this page can't show:",
      groups: [
        {
          name: null,
          lines: [
            "data/big.csv (1.05 MB) — too large to show",
            "logo.png — not text",
            "notes.md — couldn't be checked",
          ],
        },
      ],
      outro: "They are installed with the skill.",
    });
  });

  it("lists several drafts' files per draft, and leaves out the drafts without any", () => {
    expect(
      fileSection([
        { name: "csv-profiler", files: [big] },
        { name: "plot-style-guide", files: [] },
        { name: "thesis-figure-kit", files: [png, gone] },
      ])
    ).toEqual({
      intro: "Some drafts hold files this page can't show:",
      groups: [
        {
          name: "csv-profiler",
          lines: ["data/big.csv (1.05 MB) — too large to show"],
        },
        {
          name: "thesis-figure-kit",
          lines: ["logo.png — not text", "notes.md — couldn't be checked"],
        },
      ],
      outro: "They are installed with their skills.",
    });
    expect(fileSection([{ name: "x", files: [] }])).toBeUndefined();
    expect(fileSection([])).toBeUndefined();
  });

  it("gives a size only to a file listed over the limit: one that grew past it since says no size", () => {
    // Listed within the limit, but the core answered 413 when it was read:
    // its listed size isn't what makes it too large.
    const grew = { path: "grew.txt", size: 10, reason: "too_large" as const };
    const edge = {
      path: "edge.csv",
      size: 1_048_577,
      reason: "too_large" as const,
    };
    const atLimit = {
      path: "at-limit.csv",
      size: 1_048_576,
      reason: "too_large" as const,
    };
    expect(
      fileSection([{ name: "csv-profiler", files: [grew, edge, atLimit] }])
        ?.groups[0].lines
    ).toEqual([
      "grew.txt — too large to show",
      "edge.csv (1.01 MB) — too large to show",
      "at-limit.csv — too large to show",
    ]);
  });

  it("asks about the files alone, or adds them to another question", () => {
    const section = fileSection([{ name: "csv-profiler", files: [big] }]);
    expect(filesQuestion(section)).toEqual({
      title: "Install files you haven't seen?",
      description: "",
      action: "Install anyway",
      files: section,
    });
    const replace: Question = {
      title: "Replace an installed skill?",
      description: "This replaces the installed paper-review.",
      action: "Replace and install",
    };
    expect(withFiles(replace, section)).toEqual({ ...replace, files: section });
    expect(withFiles(replace, undefined)).toBe(replace);
  });

  it("keeps the files it listed while it fades out", () => {
    const one = withFiles(ask("A"), fileSection([{ name: "a", files: [big] }]));
    const other = withFiles(
      ask("A"),
      fileSection([{ name: "a", files: [png] }])
    );
    const view = renderHook(
      ({ open, live }: { open: boolean; live: Question }) =>
        useShownQuestion(open, live),
      { initialProps: { open: true, live: one } }
    );
    // Same title and sentences, other files: the files are part of the words.
    view.rerender({ open: true, live: other });
    expect(view.result.current).toEqual(other);
    view.rerender({ open: false, live: ask("A") });
    expect(view.result.current).toEqual(other);
  });
});
