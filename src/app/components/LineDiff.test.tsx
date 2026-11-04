// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LineDiff } from "./LineDiff";
import { textFileDiff } from "@/lib/fileEditDiff";

const text = (word: string) =>
  Array.from({ length: 20 }, (_, i) => `${word} ${i + 1}`).join("\n");

describe("LineDiff standalone", () => {
  it("opens a fold on request", () => {
    const diff = textFileDiff("", text("line"))!;
    render(
      <LineDiff
        diff={diff}
        heading="Files"
      />
    );

    expect(screen.getByRole("list", { name: "Files" })).toBeTruthy();
    expect(screen.queryByText("line 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more lines" }));
    expect(screen.getByText("line 7")).toBeTruthy();
  });

  it("starts folded again for a new diff object", () => {
    const first = textFileDiff("", text("line"))!;
    const { rerender } = render(
      <LineDiff
        diff={first}
        heading="Files"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 9 more lines" }));
    expect(screen.getByText("line 7")).toBeTruthy();

    rerender(
      <LineDiff
        diff={textFileDiff("", text("row"))!}
        heading="Files"
      />
    );
    expect(screen.queryByText("row 7")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show 9 more lines" })
    ).toBeTruthy();
  });
});
