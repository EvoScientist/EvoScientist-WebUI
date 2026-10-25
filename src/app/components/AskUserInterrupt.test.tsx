// @vitest-environment jsdom
//
// AskUserInterrupt is the ask_user twin of ToolApprovalInterrupt in the
// interrupt taxonomy — the backend pauses the run and asks the user
// structured questions. Component-level tests cover: text questions
// (required vs optional), multiple-choice picks, the "Other..." fallback,
// canSubmit gating, and cancel.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
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
    const red = screen.getByRole("button", { name: "red" });
    const blue = screen.getByRole("button", { name: "blue" });
    fireEvent.click(red);
    expect(red.getAttribute("aria-pressed")).toBe("true");
    expect(blue.getAttribute("aria-pressed")).toBe("false");
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

  it("allows Submit with an unpicked optional multiple-choice question, submitting an empty string", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserInterrupt
        questions={[
          {
            question: "Pick one?",
            type: "multiple_choice",
            choices: [{ value: "a" }],
            required: false,
          },
        ]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
    const submit = screen.getByRole("button", { name: /^submit$/i });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith([""]);
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

  // A goal's review (core goal.review_question): criteria up to 12,000
  // characters, one per line.
  it("keeps a long multi-line question's line breaks and lets it scroll", () => {
    const question =
      "Proposed acceptance criteria for the goal:\nWrite hello\n\n- one\n- two\n\nAccept them, or type what to change.";
    render(
      <AskUserInterrupt
        questions={[choiceQ(question, ["Accept", "Cancel"])]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const prompt = screen.getByText(/Proposed acceptance criteria/);
    expect(prompt.textContent).toContain("- one\n- two");
    expect(prompt.className).toContain("whitespace-pre-wrap");
    expect(prompt.className).toContain("overflow-y-auto");
    // Unmeasured (jsdom has no ResizeObserver), it stays a Tab stop, so a
    // keyboard can always scroll a long one (CodeRabbit, #102), with a
    // visible focus outline drawn outside it: text scrolled to its edges
    // never runs under it.
    expect(prompt.getAttribute("tabindex")).toBe("0");
    expect(prompt.className).toContain("focus-visible:outline-2");
    expect(prompt.className).toContain("focus-visible:outline-offset-2");
  });
});

// A scroll box is a Tab stop only while it has something to scroll: Safari
// can't scroll one with the keyboard otherwise, and a short question would be
// a stop for nothing (an independent review of #102).
describe("AskUserInterrupt question as a Tab stop", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  /** jsdom lays nothing out: the question's content and box read this tall. */
  const heights = (content: number, box: number) => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      content
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(box);
  };

  it("is not one when the question fits", () => {
    heights(40, 40);
    render(
      <AskUserInterrupt
        questions={[choiceQ("Accept the criteria?", ["Accept", "Cancel"])]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const prompt = screen.getByText(/Accept the criteria\?/);
    expect(prompt.hasAttribute("tabindex")).toBe(false);
  });

  it("is one while the question scrolls", () => {
    heights(900, 300);
    render(
      <AskUserInterrupt
        questions={[choiceQ("Proposed acceptance criteria", ["Accept"])]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const prompt = screen.getByText(/Proposed acceptance criteria/);
    expect(prompt.getAttribute("tabindex")).toBe("0");
  });
});
