// @vitest-environment jsdom
//
// The grader's feedback is a human message the backend adds; the chat shows
// it as a collapsed row (the CLI's "rubric: revision requested"), not as
// something the user typed.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RubricRevision } from "./RubricRevision";

const FEEDBACK = "A grader reviewed your work.\n\n- The file is missing";

describe("RubricRevision", () => {
  it("opens to the grader's feedback with its line breaks", () => {
    render(<RubricRevision content={FEEDBACK} />);
    const button = screen.getByRole("button", {
      name: "rubric: revision requested",
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/A grader reviewed/)).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const body = screen.getByText(/A grader reviewed/);
    expect(body.textContent).toBe(FEEDBACK);
    expect(body.className).toContain("whitespace-pre-wrap");
  });
});
