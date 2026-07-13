// @vitest-environment jsdom
//
// AskUserInterrupt is the ask_user twin of ToolApprovalInterrupt in the
// interrupt taxonomy — the backend pauses the run and asks the user
// structured questions. Component-level tests cover: text questions
// (required vs optional), multiple-choice picks, the "Other..." fallback,
// canSubmit gating, and cancel.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskUserInterrupt, type AskUserQuestion } from "./AskUserInterrupt";

const textQ = (question = "What next?"): AskUserQuestion => ({
  question,
  type: "text",
});

const optionalTextQ = (question = "Notes?"): AskUserQuestion => ({
  question,
  type: "text",
  required: false,
});

const choiceQ = (
  question = "Which?",
  values = ["A", "B"]
): AskUserQuestion => ({
  question,
  type: "multiple_choice",
  choices: values.map((v) => ({ value: v })),
});

describe("AskUserInterrupt", () => {
  it("renders the header and each question prompt", () => {
    render(
      <AskUserInterrupt
        questions={[textQ("What next?"), choiceQ("Which?", ["A", "B"])]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/needs your input/i)).toBeDefined();
    expect(screen.getByText("What next?")).toBeDefined();
    expect(screen.getByText("Which?")).toBeDefined();
  });

  it("keeps Submit disabled while required text answers are empty", () => {
    render(
      <AskUserInterrupt
        questions={[textQ()]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const submit = screen.getByRole("button", { name: /^submit$/i });
    expect(submit.hasAttribute("disabled")).toBe(true);

    // Type an answer — submit becomes enabled.
    const textarea = screen.getByPlaceholderText(/type your answer/i);
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("allows Submit even when an optional text question is left blank", () => {
    render(
      <AskUserInterrupt
        questions={[optionalTextQ()]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /^submit$/i }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("marks non-optional text questions with an asterisk indicator", () => {
    render(
      <AskUserInterrupt
        questions={[textQ("Required?"), optionalTextQ("Optional?")]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    // Only one asterisk — for the required question.
    const asterisks = screen.getAllByText("*");
    expect(asterisks).toHaveLength(1);
  });

  it("clicking a multiple-choice button locks in that value as the answer", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserInterrupt
        questions={[choiceQ("Which?", ["red", "blue"])]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "red" }));
    fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
    expect(onSubmit).toHaveBeenCalledWith(["red"]);
  });

  it("Other… reveals a textarea and uses its content as the answer", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserInterrupt
        questions={[choiceQ("Which?", ["red"])]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    // Before Other: no textarea.
    expect(screen.queryByPlaceholderText(/type your answer/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /other/i }));
    const textarea = screen.getByPlaceholderText(/type your answer/i);
    fireEvent.change(textarea, { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
    expect(onSubmit).toHaveBeenCalledWith(["custom"]);
  });

  it("collects answers across a mix of question types", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserInterrupt
        questions={[textQ("Free-text?"), choiceQ("Pick?", ["A"])]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/type your answer/i), {
      target: { value: "wrote this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: /^submit$/i }));
    expect(onSubmit).toHaveBeenCalledWith(["wrote this", "A"]);
  });

  it("Cancel calls onCancel and does NOT call onSubmit", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserInterrupt
        questions={[textQ()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables all controls and shows the loading label while isLoading is true", () => {
    render(
      <AskUserInterrupt
        questions={[textQ()]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        isLoading
      />
    );
    expect(
      screen
        .getByRole("button", { name: /submitting/i })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /cancel/i }).hasAttribute("disabled")
    ).toBe(true);
    const textarea = screen.getByPlaceholderText(/type your answer/i);
    expect(textarea.hasAttribute("disabled")).toBe(true);
  });
});
