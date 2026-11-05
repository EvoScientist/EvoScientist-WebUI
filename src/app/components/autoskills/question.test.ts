// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useShownQuestion, type Question } from "./question";

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
