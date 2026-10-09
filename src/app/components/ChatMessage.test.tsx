// @vitest-environment jsdom
//
// The backend pins a skill by appending a human message that carries the whole
// SKILL.md. It is context for the model, not something the user typed, so the
// chat shows a collapsed `Skill · <name>` row on the agent side instead of a
// bubble; opening it reveals the description and the SKILL.md body.

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Message } from "@langchain/langgraph-sdk";
import { ChatMessage } from "./ChatMessage";

const DESCRIPTION = "Self-review a draft across five aspects before submission";
const SKILL_BODY =
  "# Paper Review\n\nScore the manuscript on five aspects.\n\n- Soundness\n- Clarity";

const pinnedSkillMessage = (
  name?: string,
  description: unknown = DESCRIPTION
): Message =>
  ({
    id: "p1",
    type: "human",
    content: `<skill name="paper-review" path="/skills/paper-review/SKILL.md">\n${SKILL_BODY}\n</skill>`,
    additional_kwargs: {
      lc_source: "pinned_skill",
      ...(name === undefined
        ? {}
        : { skill: { name, path: "/skills/x", description } }),
    },
  } as unknown as Message);

const renderMessage = (message: Message) =>
  render(
    <ChatMessage
      message={message}
      toolCalls={[]}
    />
  );

const skillButton = () => screen.getByRole("button", { name: /^Skill · / });

describe("ChatMessage pinned skill", () => {
  it("renders a collapsed Skill row without the description or SKILL.md body", () => {
    renderMessage(pinnedSkillMessage("paper-review"));

    expect(screen.getByText("Skill · paper-review")).toBeTruthy();
    expect(skillButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
    expect(screen.queryByText(/Score the manuscript/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Paper Review" })).toBeNull();
  });

  it("shows the description and the rendered SKILL.md body once opened", () => {
    renderMessage(pinnedSkillMessage("paper-review"));

    fireEvent.click(skillButton());

    expect(skillButton().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Paper Review" })).toBeTruthy();
    expect(screen.getByText(/Score the manuscript/)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(/<skill/)).toBeNull();
  });

  it("sets SKILL.md headings to body size and bold inside the panel", () => {
    renderMessage(pinnedSkillMessage("paper-review"));

    fireEvent.click(skillButton());

    // jsdom loads no Tailwind CSS, so this checks the merged classes; the
    // computed sizes are confirmed in the browser.
    const markdownRoot = screen.getByRole("heading", { name: "Paper Review" })
      .parentElement as HTMLElement;
    const classes = markdownRoot.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "[&_h1]:text-sm",
        "[&_h1]:font-bold",
        "[&_h2]:text-sm",
        "[&_h2]:font-bold",
        "[&_h3]:text-sm",
        "[&_h3]:font-bold",
      ])
    );
    expect(classes).not.toContain("[&_h1]:font-semibold");
    expect(classes).not.toContain("[&_h2]:font-semibold");
    expect(classes).not.toContain("[&_h3]:font-semibold");
  });

  it("collapses again on a second click", () => {
    renderMessage(pinnedSkillMessage("paper-review"));

    fireEvent.click(skillButton());
    fireEvent.click(skillButton());

    expect(skillButton().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Score the manuscript/)).toBeNull();
  });

  it("omits the description when the skill has none", () => {
    renderMessage(pinnedSkillMessage("paper-review", ""));

    fireEvent.click(skillButton());

    expect(screen.getByRole("heading", { name: "Paper Review" })).toBeTruthy();
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
  });

  it("offers no copy or edit actions", () => {
    renderMessage(pinnedSkillMessage("paper-review"));

    expect(screen.queryByLabelText("Copy message")).toBeNull();
    expect(screen.queryByLabelText("Edit message")).toBeNull();
  });

  it("labels a pinned message with no skill name as unknown", () => {
    renderMessage(pinnedSkillMessage());

    expect(screen.getByText("Skill · unknown")).toBeTruthy();
  });

  it("still renders a normal user message as a bubble with its actions", () => {
    renderMessage({
      id: "u1",
      type: "human",
      content: "/paper-review check my draft",
    } as Message);

    expect(screen.getByText("/paper-review check my draft")).toBeTruthy();
    expect(screen.queryByText(/^Skill · /)).toBeNull();
    expect(screen.getByLabelText("Copy message")).toBeTruthy();
    expect(screen.getByLabelText("Edit message")).toBeTruthy();
  });
});
