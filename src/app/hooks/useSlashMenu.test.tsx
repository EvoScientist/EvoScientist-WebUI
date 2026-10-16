// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSlashMenu, type MenuSkill } from "./useSlashMenu";
import { SlashSkillMenu } from "@/app/components/SlashSkillMenu";

const SKILLS: MenuSkill[] = [
  { name: "paper-review", description: "Review your paper", source: "global" },
  { name: "paper-writing", description: "Write a paper", source: "workspace" },
  {
    name: "research-survey",
    description: "Survey the field",
    source: "global",
  },
];

function stubSkills(skills: MenuSkill[] | "error" = SKILLS) {
  const fetchMock = vi.fn(async () =>
    skills === "error"
      ? new Response("{}", { status: 500 })
      : new Response(JSON.stringify({ skills }))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// The composer in miniature: a textarea that submits on Enter unless the menu
// took the key, as ChatInterface wires it.
function Composer({
  onSubmit = () => {},
  onBrowse = () => {},
  disabled = false,
}: {
  onSubmit?: (value: string) => void;
  onBrowse?: () => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const slash = useSlashMenu({
    textareaRef,
    value,
    setValue,
    onBrowse,
    disabled,
  });
  return (
    <div
      ref={anchorRef}
      data-testid="anchor"
    >
      <textarea
        ref={textareaRef}
        aria-label="Message"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          slash.onChange(e);
        }}
        onKeyDown={(e) => {
          if (slash.onKeyDown(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          }
        }}
        {...slash.textareaProps}
      />
      <SlashSkillMenu
        {...slash.menuProps}
        anchorRef={anchorRef}
      />
    </div>
  );
}

const box = () => screen.getByRole("textbox", { name: "Message" });
const type = (text: string) => {
  act(() => box().focus());
  fireEvent.change(box(), { target: { value: text } });
};
const options = () =>
  screen.queryAllByRole("option").map((o) => o.textContent ?? "");
const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(box(), { key: k, ...init });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSlashMenu", () => {
  it("lists the installed skills when a message starts with /", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
    expect(options()[1]).toContain("/paper-writing");
    expect(options()[1]).toContain("Write a paper");
    expect(options()[1]).toContain("workspace");
  });

  it("filters as the name grows and closes when nothing matches", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    type("/paper-w");
    expect(options()).toHaveLength(1);
    type("/zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("doesn't open for a slash that wouldn't pin", async () => {
    const fetchMock = stubSkills();
    render(<Composer />);
    type("see /pa");
    type("/docs/a");
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inserts the chosen name with the keyboard, without sending", async () => {
    stubSkills();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
    key("ArrowDown");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe(
      "true"
    );
    key("ArrowUp");
    key("ArrowUp"); // wraps to the last
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe(
      "true"
    );
    key("Enter");
    expect((box() as HTMLTextAreaElement).value).toBe("/research-survey ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();

    // A second pin, with Tab; the first one isn't offered again.
    type("/research-survey /pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Tab");
    expect((box() as HTMLTextAreaElement).value).toBe(
      "/research-survey /paper-review "
    );
  });

  it("inserts the clicked name and keeps focus in the composer", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    const option = screen.getAllByRole("option")[1];
    // A mousedown that would move focus is held back.
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect((box() as HTMLTextAreaElement).value).toBe("/paper-writing ");
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("closes with Escape, and sends with Enter once closed", async () => {
    stubSkills();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    key("Enter");
    expect(onSubmit).toHaveBeenCalledWith("/pa");
    // Typing on opens it again.
    type("/pap");
    await waitFor(() => expect(options()).toHaveLength(2));
  });

  it("stays shut while an input method composes", async () => {
    stubSkills();
    render(<Composer />);
    act(() => box().focus());
    fireEvent.compositionStart(box());
    fireEvent.change(box(), { target: { value: "/" } });
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.compositionEnd(box());
    await waitFor(() => expect(options()).toHaveLength(3));
  });

  it("closes when the composer loses focus", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    act(() => box().blur());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("points to the marketplace when no skill is installed", async () => {
    stubSkills([]);
    const onBrowse = vi.fn();
    render(<Composer onBrowse={onBrowse} />);
    type("/");
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /No skills installed/ })
      ).toBeTruthy()
    );
    key("Enter");
    expect(onBrowse).toHaveBeenCalled();
    // Only for a bare slash: a name being typed just doesn't match.
    type("/pa");
    expect(
      screen.queryByRole("option", { name: /No skills installed/ })
    ).toBeNull();
  });

  it("stays shut when the skills can't be read", async () => {
    const fetchMock = stubSkills("error");
    render(<Composer />);
    type("/");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reads the list again each time it opens, and shows the new one", async () => {
    const fetchMock = stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    type("");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              {
                name: "new-skill",
                description: "Just installed",
                source: "global",
              },
            ],
          })
        )
    );
    type("/");
    await waitFor(() =>
      expect(options()).toEqual(["/new-skillJust installed"])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows only the list this opening read", async () => {
    const fetchMock = stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    type("");
    // Reopened while the answer is on its way: nothing old to pick (a skill
    // removed since would pin nothing).
    let answer: (res: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (answer = resolve))
    );
    type("/");
    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () =>
      answer(new Response(JSON.stringify({ skills: [SKILLS[0]] })))
    );
    expect(options()).toEqual(["/paper-reviewReview your paper"]);
    // A failed answer leaves it shut, not showing the last list.
    type("");
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 500 })
    );
    type("/");
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the newest list when an older answer comes back later", async () => {
    const answers: Array<(skills: MenuSkill[]) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            answers.push((skills) =>
              resolve(new Response(JSON.stringify({ skills })))
            )
          )
      )
    );
    render(<Composer />);
    type("/");
    type("");
    type("/");
    expect(answers).toHaveLength(2);
    await act(async () => answers[1]([SKILLS[0]]));
    await act(async () => answers[0](SKILLS));
    expect(options()).toEqual(["/paper-reviewReview your paper"]);
  });

  it("opens again after Escape once the typing changes", async () => {
    stubSkills();
    render(<Composer />);
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/p");
    await waitFor(() => expect(options()).toHaveLength(2));
    type("/pa");
    expect(options()).toHaveLength(2);
    // And in the next message.
    key("Escape");
    type("");
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
  });

  it("reads the list again when it opens after an Escape", async () => {
    const fetchMock = stubSkills();
    render(<Composer />);
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Escape");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              {
                name: "paper-graph",
                description: "Just installed",
                source: "global",
              },
            ],
          })
        )
    );
    type("/p");
    await waitFor(() =>
      expect(options()).toEqual(["/paper-graphJust installed"])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens again when the composer gets focus after an Escape", async () => {
    stubSkills();
    render(<Composer />);
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    // As after a blur: a fresh focus starts fresh.
    fireEvent.focus(box());
    await waitFor(() => expect(options()).toHaveLength(2));
  });

  it("lets keys with modifiers through", async () => {
    stubSkills();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    for (const init of [
      { key: "ArrowDown", shiftKey: true },
      { key: "ArrowDown", altKey: true },
      { key: "Tab", shiftKey: true },
    ]) {
      expect(fireEvent.keyDown(box(), init)).toBe(true);
    }
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe(
      "true"
    );
    // Ctrl / Cmd + Enter reach the composer, which sends.
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect((box() as HTMLTextAreaElement).value).toBe("/");
  });

  it("leaves keys alone while an input method composes", async () => {
    stubSkills();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    // Not the menu's: the composer got the key, nothing was inserted.
    expect((box() as HTMLTextAreaElement).value).toBe("/");
    expect(onSubmit).toHaveBeenCalledWith("/");
  });

  it("closes on the way to the marketplace, and reads the list on return", async () => {
    const fetchMock = stubSkills([]);
    const onBrowse = vi.fn();
    render(<Composer onBrowse={onBrowse} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
    // A skill installed there; the chat comes back without a blur (a hidden
    // column may not fire one), and the composer gets focus again with its
    // "/" as it was.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ skills: [SKILLS[0]] }))
    );
    fireEvent.focus(box());
    await waitFor(() =>
      expect(options()).toEqual(["/paper-reviewReview your paper"])
    );
    // Focus reads the list again while the menu is open, too.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ skills: [SKILLS[1]] }))
    );
    fireEvent.focus(box());
    await waitFor(() =>
      expect(options()).toEqual(["/paper-writingWrite a paperworkspace"])
    );
  });

  it("only goes to the marketplace on Enter or a click", async () => {
    stubSkills([]);
    const onBrowse = vi.fn();
    render(<Composer onBrowse={onBrowse} />);
    type("/");
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /No skills installed/ })
      ).toBeTruthy()
    );
    expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(true);
    expect(onBrowse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option"));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it("closes when the composer is disabled", async () => {
    stubSkills();
    const { rerender } = render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    rerender(<Composer disabled />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("points the textarea at the top match as the list changes", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    const first = box().getAttribute("aria-activedescendant");
    type("/re");
    const top = screen.getAllByRole("option")[0];
    expect(top.textContent).toContain("/research-survey");
    expect(box().getAttribute("aria-activedescendant")).toBe(top.id);
    expect(top.id).not.toBe(first);
  });

  it("tells screen readers how many skills match", async () => {
    stubSkills();
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toBe("");
    type("/");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("3 skills")
    );
    type("/paper-w");
    expect(screen.getByRole("status").textContent).toBe("1 skill");
  });

  it("sits above the composer at its width, within the room above it", async () => {
    stubSkills();
    render(<Composer />);
    const rect = { left: 100, top: 500, width: 600, height: 80 };
    screen.getByTestId("anchor").getBoundingClientRect = () =>
      ({
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      } as DOMRect);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    const menu = screen.getByRole("listbox").parentElement!;
    expect(menu.style.left).toBe("100px");
    expect(menu.style.width).toBe("600px");
    expect(menu.style.bottom).toBe(`${window.innerHeight - 500 + 6}px`);
    // The whole box fits the room above, hint row and borders included; the
    // list inside keeps its own 18rem cap and scrolls.
    expect(menu.style.maxHeight).toBe("486px");
    expect(screen.getByRole("listbox").className).toContain("max-h-72");
    // It follows when the composer moves without resizing (a panel opening
    // beside the chat), not only on window resize or scroll.
    rect.left = 260;
    await waitFor(() => expect(menu.style.left).toBe("260px"));
  });
});
