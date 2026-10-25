// @vitest-environment jsdom
//
// The backend pins a skill by appending a human message that carries the whole
// SKILL.md. It is context for the model, not something the user typed, so the
// chat shows a collapsed `Skill · <name>` row on the agent side instead of a
// bubble; opening it reveals the description and the SKILL.md body.

import { describe, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Message } from "@langchain/langgraph-sdk";
import { ChatMessage } from "./ChatMessage";
import { copyText } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
import { createThinkingClock } from "@/lib/thinkingTimer";

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

// Models put their reasoning in one of two places: OpenAI-compatible routes
// (DeepSeek, OpenRouter) in `additional_kwargs.reasoning_content`, Anthropic's
// extended thinking in `thinking` content blocks ahead of the text (the shape
// below is what claude-sonnet-5-5 returned through the backend on 2026-10-19).
describe("ChatMessage thinking", () => {
  const THOUGHT =
    "17 × 23: breaking it down as 17×20 plus 17×3 gives 340+51=391.";
  const aiMessage = (
    content: Message["content"],
    additional_kwargs: Record<string, unknown> = {}
  ): Message =>
    ({
      id: "a1",
      type: "ai",
      content,
      additional_kwargs,
    } as unknown as Message);
  const thinkingButton = () =>
    screen.queryByRole("button", { name: /^(Thinking…|Thought)/ });

  it("shows Claude's thinking block, collapsed, apart from the answer", () => {
    renderMessage(
      aiMessage([
        {
          type: "thinking",
          thinking: THOUGHT,
          signature: "EqQBCkYIBxgC",
          index: 0,
        },
        { type: "text", text: "391", index: 1 },
      ] as unknown as Message["content"])
    );

    expect(screen.getByText("391")).toBeTruthy();
    expect(screen.queryByText(THOUGHT)).toBeNull();
    fireEvent.click(thinkingButton()!);
    expect(screen.getByText(THOUGHT)).toBeTruthy();
  });

  it("shows the thinking while it is all that has streamed so far", () => {
    renderMessage(
      aiMessage([
        { type: "thinking", thinking: "Working out 17 × 23", index: 0 },
      ] as unknown as Message["content"])
    );

    expect(thinkingButton()).toBeTruthy();
  });

  // DeepSeek's and Claude's reasoning is plain scratch text: shown exactly as
  // written (line breaks kept, nothing read as HTML, math or emphasis).
  const PLAIN =
    "Step 1: 17×20 = 340\nStep 2: 17×3 = 51\nIf x<y and z>w swap them; $5 and $10; 2*3*4 = 24";
  it.each([
    ["reasoning_content", aiMessage("391", { reasoning_content: PLAIN })],
    [
      "a thinking block",
      aiMessage([
        { type: "thinking", thinking: PLAIN },
        { type: "text", text: "391" },
      ] as unknown as Message["content"]),
    ],
    [
      "a standard reasoning block",
      aiMessage([
        { type: "reasoning", reasoning: PLAIN },
        { type: "text", text: "391" },
      ] as unknown as Message["content"]),
    ],
  ])("shows %s exactly as written", (_label, message) => {
    renderMessage(message);

    fireEvent.click(thinkingButton()!);
    const panel = thinkingButton()!.nextElementSibling as HTMLElement;
    expect(panel.textContent).toBe(PLAIN);
    expect(panel.querySelector(".katex, em, strong")).toBeNull();
  });

  // OpenAI's Responses API (ChatGPT sign-in, API-key OpenAI) returns only a
  // reasoning summary: a title and a paragraph as summary_text parts, next to
  // encrypted reasoning (shape recorded with gpt-6.1-sol on 2026-10-14).
  it("shows an OpenAI reasoning summary, its parts in order", () => {
    renderMessage(
      aiMessage([
        {
          type: "reasoning",
          id: "rs_0a1b2c",
          encrypted_content: "gAAAAABo",
          summary: [
            {
              type: "summary_text",
              text: "**Multiplying 17 by 23**",
              index: 0,
            },
            {
              type: "summary_text",
              text: `${THOUGHT} It returns Array<Message>.`,
              index: 1,
            },
          ],
          index: 0,
        },
        { type: "text", text: "391", index: 1 },
      ] as unknown as Message["content"])
    );

    fireEvent.click(thinkingButton()!);
    // Rendered as Markdown: the title is bold, not wrapped in asterisks, and
    // comes before the paragraph.
    const title = screen.getByText("Multiplying 17 by 23");
    expect(title.tagName).toBe("STRONG");
    const text = (title.closest(".prose") as HTMLElement).textContent ?? "";
    expect(text).not.toContain("**");
    // Angle brackets stay text, not HTML that the sanitizer would drop.
    expect(text).toContain("Array<Message>");
    expect(text.indexOf("Multiplying 17 by 23")).toBeLessThan(
      text.indexOf(THOUGHT)
    );
  });

  // Headings in a summary read at body size, as in the pinned-skill panel.
  it("keeps headings in a reasoning summary at body size", () => {
    renderMessage(
      aiMessage([
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "## Plan\n\nMultiply." }],
        },
        { type: "text", text: "391" },
      ] as unknown as Message["content"])
    );

    fireEvent.click(thinkingButton()!);
    const panel = screen.getByRole("heading", { name: "Plan" })
      .parentElement as HTMLElement;
    expect(panel.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["[&_h2]:text-sm", "[&_h2]:font-bold"])
    );
  });

  // langchain's standard block carries the same text in a `reasoning` string.
  it("shows a standard reasoning block", () => {
    renderMessage(
      aiMessage([
        { type: "reasoning", reasoning: THOUGHT },
        { type: "text", text: "391" },
      ] as unknown as Message["content"])
    );

    fireEvent.click(thinkingButton()!);
    expect(screen.getByText(THOUGHT)).toBeTruthy();
  });

  // Reasoning OpenAI keeps encrypted, with no summary, has nothing to show.
  it("shows nothing for a reasoning block without a summary", () => {
    renderMessage(
      aiMessage([
        {
          type: "reasoning",
          id: "rs_0a1b2c",
          encrypted_content: "gAAAAABo",
          summary: [],
        },
        { type: "text", text: "391" },
      ] as unknown as Message["content"])
    );

    expect(thinkingButton()).toBeNull();
  });

  // Anthropic encrypts some thinking; it carries no text to show.
  it("shows nothing for redacted thinking", () => {
    renderMessage(
      aiMessage([
        { type: "redacted_thinking", data: "EmwKAhgBEgy3va" },
        { type: "text", text: "391" },
      ] as unknown as Message["content"])
    );

    expect(screen.getByText("391")).toBeTruthy();
    expect(thinkingButton()).toBeNull();
  });

  it("shows reasoning_content as before", () => {
    renderMessage(aiMessage("391", { reasoning_content: THOUGHT }));

    fireEvent.click(thinkingButton()!);
    expect(screen.getByText(THOUGHT)).toBeTruthy();
  });

  // While streaming, the block opens empty (thinking "" and an empty
  // signature) and fills in; the control appears once there is text.
  it("shows the thinking once the streamed block has text", () => {
    // Only the content changes between the two renders, as in a stream.
    const kwargs = {};
    const { rerender } = renderMessage(
      aiMessage(
        [
          { type: "thinking", thinking: "", signature: "", index: 0 },
        ] as unknown as Message["content"],
        kwargs
      )
    );
    expect(thinkingButton()).toBeNull();

    rerender(
      <ChatMessage
        message={aiMessage(
          [
            {
              type: "thinking",
              thinking: "Working out",
              signature: "",
              index: 0,
            },
          ] as unknown as Message["content"],
          kwargs
        )}
        toolCalls={[]}
      />
    );
    expect(thinkingButton()).toBeTruthy();
  });

  // The backend CLI reads reasoning_content first and the blocks only when it
  // is empty; a message carrying both shows its reasoning once.
  it("prefers reasoning_content over thinking blocks, as the CLI does", () => {
    renderMessage(
      aiMessage(
        [
          { type: "thinking", thinking: THOUGHT },
          { type: "text", text: "391" },
        ] as unknown as Message["content"],
        { reasoning_content: THOUGHT }
      )
    );

    fireEvent.click(thinkingButton()!);
    expect(screen.getAllByText(THOUGHT)).toHaveLength(1);
  });

  // While the model still thinks the row says so; once the answer or a tool
  // call starts, it says how long it took (timed by useChat's clock).
  describe("progress", () => {
    const thinking = (id: string) =>
      ({
        id,
        type: "ai",
        content: [{ type: "thinking", thinking: THOUGHT, index: 0 }],
      } as unknown as Message);
    const answered = (id: string) =>
      ({
        id,
        type: "ai",
        content: [
          { type: "thinking", thinking: THOUGHT, index: 0 },
          { type: "text", text: "391", index: 1 },
        ],
      } as unknown as Message);
    // Times a reply the way useChat does: a run started here, its reply
    // thinking at 0 s and answering `seconds` later.
    const timeReply = (id: string, seconds: number) => {
      const clock = createThinkingClock();
      clock.runStarting();
      clock.observe([thinking(id)], true, 0);
      clock.observe([answered(id)], true, seconds * 1000);
    };

    it("says Thinking… while the reasoning streams", () => {
      render(
        <ChatMessage
          message={thinking("p1")}
          toolCalls={[]}
          isStreaming
        />
      );

      const button = screen.getByRole("button", { name: "Thinking…" });
      expect(button.querySelector(".thinking-shimmer")).not.toBeNull();
    });

    it("says how long it thought", () => {
      timeReply("p2", 12);
      render(
        <ChatMessage
          message={answered("p2")}
          toolCalls={[]}
          isStreaming
        />
      );

      expect(
        screen.getByRole("button", { name: "Thought for 12s" })
      ).toBeTruthy();
      expect(document.querySelector(".thinking-shimmer")).toBeNull();
    });

    // useChat records the time from the live stream, which can be after the
    // reply rendered.
    it("shows the time once it is recorded", () => {
      render(
        <ChatMessage
          message={answered("p3")}
          toolCalls={[]}
          isStreaming
        />
      );
      expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();

      act(() => timeReply("p3", 7));

      expect(
        screen.getByRole("button", { name: "Thought for 7s" })
      ).toBeTruthy();
    });

    it("stops saying Thinking… once a tool call starts", () => {
      render(
        <ChatMessage
          message={thinking("p6")}
          toolCalls={[{ id: "c1", name: "ls", args: {}, status: "pending" }]}
          isStreaming
        />
      );

      expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
    });

    it("says Thought for a reply stopped while it thought", () => {
      render(
        <ChatMessage
          message={thinking("p5")}
          toolCalls={[]}
        />
      );

      expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
    });

    it("says Thought for a message loaded from history", () => {
      render(
        <ChatMessage
          message={answered("p4")}
          toolCalls={[]}
        />
      );

      expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
    });
  });

  // A malformed message can hold null entries; the reasoning reader skips
  // them (it already did; this keeps it so).
  it("shows a reply whose content holds null entries", () => {
    renderMessage(
      aiMessage([
        null,
        { type: "thinking", thinking: THOUGHT },
        { type: "text", text: "391" },
      ] as unknown as Message["content"])
    );

    expect(screen.getByText("391")).toBeTruthy();
    fireEvent.click(thinkingButton()!);
    expect(screen.getByText(THOUGHT)).toBeTruthy();
  });

  it("shows no Thinking control when there is no reasoning", () => {
    renderMessage(aiMessage("391"));

    expect(thinkingButton()).toBeNull();
  });
});

describe("ChatMessage sub-agent", () => {
  const args = { subagent_type: "code-agent", description: "do it" };
  const taskMessage = {
    id: "a1",
    type: "ai",
    content: "",
    tool_calls: [{ id: "tc1", name: "task", args }],
  } as unknown as Message;
  const LAST = "LAST-WORDS from the sub-agent";
  const renderTask = (status: "completed" | "error", result: string) =>
    render(
      <ChatMessage
        message={taskMessage}
        toolCalls={[{ id: "tc1", name: "task", args, status, result }]}
        subAgentSteps={{ tc1: [{ kind: "text", text: LAST }] }}
      />
    );

  // A failed task's output is the error, not the sub-agent's last text.
  it("shows a failed sub-agent's last text next to the error", () => {
    renderTask("error", "Error: code-agent crashed");
    fireEvent.click(
      screen.getByRole("button", { name: "code-agent subagent failed" })
    );
    expect(screen.queryByRole("button", { name: /task/ })).toBeNull();

    expect(screen.getByText(LAST)).toBeTruthy();
    expect(screen.getByText("Error: code-agent crashed")).toBeTruthy();
  });

  it("shows a finished sub-agent's last text once, as its output", () => {
    renderTask("completed", LAST);
    fireEvent.click(
      screen.getByRole("button", { name: "code-agent subagent finished" })
    );
    expect(screen.queryByRole("button", { name: /task/ })).toBeNull();

    expect(screen.getAllByText(LAST)).toHaveLength(1);
  });

  // deepagents requires subagent_type; a call without it fails validation.
  const bareTask = (
    status: "pending" | "error" | "stopped" | "interrupted",
    args: Record<string, unknown> = { description: "do it" }
  ) => {
    const call = { id: "tc2", name: "task", args };
    return render(
      <ChatMessage
        message={
          {
            id: "a2",
            type: "ai",
            content: "",
            tool_calls: [call],
          } as unknown as Message
        }
        toolCalls={[
          {
            ...call,
            status,
            result:
              status === "error"
                ? "Error: subagent_type is a required field"
                : undefined,
          },
        ]}
      />
    );
  };

  it("shows a task call that never named its sub-agent as a tool row", () => {
    bareTask("error");

    expect(screen.getByLabelText("Failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /task/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /subagent/ })).toBeNull();
  });

  it("shows no row for a task call still streaming in", () => {
    bareTask("pending");

    expect(screen.queryByRole("button", { name: /task/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /subagent/ })).toBeNull();
  });

  it.each(["stopped", "interrupted"] as const)(
    "shows a %s task call that never named its sub-agent as a row",
    (status) => {
      bareTask(status);

      expect(screen.getByRole("button", { name: /task/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /subagent/ })).toBeNull();
    }
  );

  // A model can send a sub-agent that isn't a name; a card would crash on it.
  it.each([[{}], [["code-agent"]], [true], ["  "]])(
    "shows a task call whose subagent_type is %j as a tool row",
    (subagentType) => {
      bareTask("error", { description: "do it", subagent_type: subagentType });

      expect(screen.getByLabelText("Failed")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /subagent/ })).toBeNull();
    }
  );
});

describe("ChatMessage rubric revision", () => {
  it("shows the grader's feedback as a collapsed row, not a user bubble", () => {
    renderMessage({
      id: "r1",
      type: "human",
      name: "rubric_grader",
      content: "A grader reviewed your work and asked for revisions.",
      additional_kwargs: { lc_source: "rubric_grader" },
    } as unknown as Message);
    expect(
      screen.getByRole("button", { name: "rubric: revision requested" })
    ).toBeTruthy();
    expect(
      screen.queryByText("A grader reviewed your work and asked for revisions.")
    ).toBeNull();
  });
});

// A sent message's leading `/name` words the backend pinned (its markers
// follow it) show as chips, as they did in the composer; the message is
// still the text that was sent.
describe("ChatMessage pinned skill chips", () => {
  const userMessage = (content: string): Message =>
    ({ id: "h1", type: "human", content } as unknown as Message);

  it("draws the pinned skills as chips ahead of the text", async () => {
    render(
      <ChatMessage
        message={userMessage("/paper-review hi")}
        toolCalls={[]}
        pinnedSkills={["paper-review"]}
      />
    );
    const chips = [...document.querySelectorAll('[data-slot="composer-chip"]')];
    expect(chips.map((c) => c.textContent)).toEqual(["paper-review"]);
    const bubble = chips[0].closest("p")!;
    expect(bubble.lastChild?.textContent).toBe("hi");
    // A screen reader reads the message as sent.
    expect(bubble.querySelector(".sr-only")?.textContent).toBe(
      "/paper-review "
    );
    expect(chips[0].closest('[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Copy message"));
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith("/paper-review hi")
    );
  });

  it("leaves a slash word that wasn't pinned as text", () => {
    render(
      <ChatMessage
        message={userMessage("/paper-review hi")}
        toolCalls={[]}
        pinnedSkills={[]}
      />
    );
    expect(document.querySelector('[data-slot="composer-chip"]')).toBeNull();
    expect(screen.getByText("/paper-review hi")).toBeTruthy();
  });
});
