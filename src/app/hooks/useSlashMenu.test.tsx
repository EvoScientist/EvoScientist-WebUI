// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useSlashMenu, type MenuSkill } from "./useSlashMenu";
import { SlashSkillMenu } from "@/app/components/SlashSkillMenu";
import { GOAL_MENU_COMMANDS } from "@/lib/goalCommand";
import { MODEL_MENU_COMMANDS } from "@/lib/modelCommand";
import type { MenuCommand } from "@/lib/slashMenu";

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
  commands,
  runnerFor,
}: {
  onSubmit?: (value: string) => void;
  onBrowse?: () => void;
  disabled?: boolean;
  commands?: readonly MenuCommand[];
  runnerFor?: (command: MenuCommand) => (() => void) | null;
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
    commands,
    runnerFor,
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
    expect(options()[1]).toContain("Workspace");
    expect(options()[0]).toContain("Global");
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
      expect(options()).toEqual(["/new-skillJust installedGlobal"])
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
    expect(options()).toEqual(["/paper-reviewReview your paperGlobal"]);
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
    expect(options()).toEqual(["/paper-reviewReview your paperGlobal"]);
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
      expect(options()).toEqual(["/paper-graphJust installedGlobal"])
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
      expect(options()).toEqual(["/paper-reviewReview your paperGlobal"])
    );
    // Focus reads the list again while the menu is open, too.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ skills: [SKILLS[1]] }))
    );
    fireEvent.focus(box());
    await waitFor(() =>
      expect(options()).toEqual(["/paper-writingWrite a paperWorkspace"])
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
    // list inside keeps its own 24rem cap (room for a few skills under the
    // commands and the two headings) and scrolls.
    expect(menu.style.maxHeight).toBe("486px");
    expect(screen.getByRole("listbox").className).toContain("max-h-96");
    // It follows when the composer moves without resizing (a panel opening
    // beside the chat), not only on window resize or scroll.
    rect.left = 260;
    await waitFor(() => expect(menu.style.left).toBe("260px"));
  });
});

describe("useSlashMenu commands", () => {
  it("lists the /goal commands above the skills at the start of a message", async () => {
    stubSkills();
    render(<Composer commands={GOAL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(8));
    expect(
      screen.getByRole("listbox", { name: "Commands and skills" })
    ).toBeTruthy();
    expect(options()[0]).toContain("/goal <objective>");
    expect(options()[0]).toContain(
      "Set a goal with drafted acceptance criteria"
    );
    expect(options()[4]).toContain("/goal clear");
    expect(options()[5]).toContain("/paper-review");
  });

  it("keeps the /goal commands while the word is the start of goal", async () => {
    stubSkills();
    render(<Composer commands={GOAL_MENU_COMMANDS} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(5));
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options().some((o) => o.includes("/goal"))).toBe(false);
  });

  it("offers commands only as the message's first word", async () => {
    stubSkills();
    render(<Composer commands={GOAL_MENU_COMMANDS} />);
    type("/paper-review /");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(options().some((o) => o.includes("/goal"))).toBe(false);
  });

  it("shows no command rows without commands", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
  });

  it("writes the chosen command in place of the word, with the keyboard", async () => {
    stubSkills();
    const onSubmit = vi.fn();
    render(
      <Composer
        commands={GOAL_MENU_COMMANDS}
        onSubmit={onSubmit}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(8));
    key("ArrowDown");
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1].id
    );
    key("Enter");
    expect((box() as HTMLTextAreaElement).value).toBe("/goal amend ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("writes a command chosen with a click", async () => {
    stubSkills();
    render(<Composer commands={GOAL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(8));
    fireEvent.click(screen.getAllByRole("option")[2]);
    expect((box() as HTMLTextAreaElement).value).toBe("/goal pause");
  });

  // A command that needs nothing more (/model opens the picker) runs when
  // chosen with Enter or a click: the typed word goes and its runner runs.
  // Tab still writes it out.
  it("runs a command that needs nothing more when chosen", async () => {
    stubSkills();
    const onRun = vi.fn();
    const onSubmit = vi.fn();
    render(
      <Composer
        commands={MODEL_MENU_COMMANDS}
        runnerFor={(command) => () => onRun(command)}
        onSubmit={onSubmit}
      />
    );
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(onRun).toHaveBeenCalledWith(MODEL_MENU_COMMANDS[0]);
    expect((box() as HTMLTextAreaElement).value).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(onRun).toHaveBeenCalledTimes(2);
    expect((box() as HTMLTextAreaElement).value).toBe("");
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Tab");
    expect(onRun).toHaveBeenCalledTimes(2);
    expect((box() as HTMLTextAreaElement).value).toBe("/model");
  });

  // Text after the typed word stays, without the separator the menu split
  // on (Python's whitespace, U+0085 included), and the caret goes where the
  // word was, so typing on starts there.
  it("keeps the text after the word, with the caret where the word was", async () => {
    stubSkills();
    const onRun = vi.fn();
    render(
      <Composer
        commands={MODEL_MENU_COMMANDS}
        runnerFor={() => onRun}
      />
    );
    const el = box() as HTMLTextAreaElement;
    fireEvent.change(el, { target: { value: "/mo\u0085draft" } });
    el.setSelectionRange(3, 3);
    fireEvent.select(el);
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(el.value).toBe("draft");
    await waitFor(() => expect(el.selectionStart).toBe(0));
    expect(el.selectionEnd).toBe(0);
  });

  // A run command the composer can't run is an ordinary row: the hint says
  // Enter inserts it, and Enter writes it out, so its typed word isn't lost.
  it("treats a run command the composer can't run as an ordinary row", async () => {
    stubSkills();
    render(
      <Composer
        commands={MODEL_MENU_COMMANDS}
        runnerFor={() => null}
      />
    );
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(screen.getByText(/to choose/).textContent).toBe(
      "↑ ↓ to choose · Enter or Tab to insert · Esc to close"
    );
    key("Enter");
    expect((box() as HTMLTextAreaElement).value).toBe("/model");
  });

  // The hint under the list says what Enter does on the highlighted row.
  it("says what Enter does on the highlighted row", async () => {
    stubSkills([]);
    render(
      <Composer
        commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]}
        runnerFor={() => () => {}}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(7));
    const hint = () => screen.getByText(/to choose/).textContent;
    expect(hint()).toBe(
      "↑ ↓ to choose · Enter or Tab to insert · Esc to close"
    );
    key("ArrowUp");
    expect(hint()).toBe("↑ ↓ to choose · Enter to open · Esc to close");
    key("ArrowUp");
    expect(hint()).toBe(
      "↑ ↓ to choose · Enter to run · Tab to insert · Esc to close"
    );
  });

  // Commands and skills sit under their own headings, with a rule between
  // them; the headings aren't options, so the keys skip them.
  it("groups the commands and the skills under their headings", async () => {
    stubSkills();
    render(
      <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(9));
    const commands = screen.getByRole("group", { name: "Commands" });
    const skills = screen.getByRole("group", { name: "Skills" });
    expect(within(commands).getAllByRole("option")).toHaveLength(6);
    expect(within(skills).getAllByRole("option")).toHaveLength(3);
    expect(skills.className).toContain("border-t");
    expect(commands.className).not.toContain("border-t");
    for (let i = 0; i < 6; i++) key("ArrowDown");
    expect(box().getAttribute("aria-activedescendant")).toBe(
      within(skills).getAllByRole("option")[0].id
    );
  });

  it("puts the way to the marketplace under Skills when none is installed", async () => {
    stubSkills([]);
    render(<Composer commands={MODEL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(
      within(screen.getByRole("group", { name: "Skills" })).getByRole("option")
        .textContent
    ).toContain("No skills installed");
  });

  it("shows only the headings with rows under them", async () => {
    stubSkills();
    render(
      <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
    );
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(screen.queryByRole("group", { name: "Commands" })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Skills" }).className
    ).not.toContain("border-t");
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(5));
    expect(screen.queryByRole("group", { name: "Skills" })).toBeNull();
    // The list is named for what it shows.
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
  });

  // The first row of a section brings its heading into view too: with the
  // list scrolled, wrapping to the top or stepping into Skills from above
  // would otherwise leave the heading out of sight.
  it("scrolls a section's heading into view with its first row", async () => {
    const scrolled: string[] = [];
    const proto = Element.prototype as unknown as {
      scrollIntoView?: (arg?: unknown) => void;
    };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      stubSkills();
      render(
        <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
      );
      type("/");
      await waitFor(() => expect(options()).toHaveLength(9));
      // Down into Skills: its heading, then its first row.
      for (let n = 0; n < 6; n++) key("ArrowDown");
      await waitFor(() =>
        expect(scrolled.slice(-2)).toEqual([
          "Skills",
          expect.stringContaining("/paper-review"),
        ])
      );
      // A row further down scrolls only itself.
      key("ArrowDown");
      await waitFor(() =>
        expect(scrolled[scrolled.length - 1]).toContain("/paper-writing")
      );
      expect(scrolled[scrolled.length - 2]).toContain("/paper-review");
      // Wrapping to the top brings "Commands" back with the first row.
      key("ArrowDown");
      key("ArrowDown");
      await waitFor(() =>
        expect(scrolled.slice(-2)).toEqual([
          "Commands",
          expect.stringContaining("/goal <objective>"),
        ])
      );
    } finally {
      proto.scrollIntoView = original;
    }
  });

  // Each row has an icon (the goal pill's, the model pill's, a skill's), and
  // each skill says where it comes from.
  it("marks every row with an icon and every skill with its source", async () => {
    stubSkills();
    render(
      <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(9));
    const rows = screen.getAllByRole("option");
    expect(
      rows.every((row) => row.querySelector('svg[aria-hidden="true"]'))
    ).toBe(true);
    expect(rows[6].textContent).toContain("Global");
    expect(rows[7].textContent).toContain("Workspace");
  });

  // On a narrow screen a long name gives way (it truncates) before the
  // skill's source, which keeps its place at the row's end (at 320 px a long
  // name pushed "Global" out of the row).
  it("lets a long name give way before the skill's source", async () => {
    stubSkills();
    render(<Composer commands={MODEL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(4));
    const [commandRow, skillRow] = screen.getAllByRole("option");
    for (const row of [commandRow, skillRow]) {
      const name = row.querySelector(":scope > span")!;
      expect(name.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["min-w-0", "truncate"])
      );
      expect(name.className).not.toContain("shrink-0");
    }
    const spans = skillRow.querySelectorAll(":scope > span");
    expect(spans[spans.length - 1].className).toContain("shrink-0");
  });

  // Each opening starts on the first row: a highlight is remembered only
  // while its word stays typed (a bare "/" retyped is a new opening).
  it("starts each opening on the first row", async () => {
    stubSkills([]);
    render(
      <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(7));
    key("ArrowUp");
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[6].id
    );
    type("");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    type("/");
    await waitFor(() => expect(options()).toHaveLength(7));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
  });

  // An explicit close (Escape, the way to the marketplace) also starts the
  // next opening on the first row, though the word stays typed.
  it("starts on the first row after an Escape or the marketplace", async () => {
    const fetchMock = stubSkills([]);
    const onBrowse = vi.fn();
    render(
      <Composer
        commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]}
        onBrowse={onBrowse}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(7));
    key("ArrowUp");
    key("ArrowUp");
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.focus(box());
    await waitFor(() => expect(options()).toHaveLength(7));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
    // The marketplace: a skill installed there, back without a blur.
    key("ArrowUp");
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ skills: [SKILLS[0]] }))
    );
    fireEvent.focus(box());
    await waitFor(() => expect(options()).toHaveLength(7));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
  });

  // globals.css gives every li a bottom margin: the menu's rows and headings
  // cancel it, so there is no dead strip between rows.
  it("leaves no gap between the menu's rows", async () => {
    stubSkills();
    render(
      <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(9));
    const items = screen.getByRole("listbox").querySelectorAll("li");
    expect(items.length).toBeGreaterThan(9);
    for (const item of items) {
      expect(item.className.split(/\s+/)).toContain("mb-0");
    }
  });

  // Rows can come in above the highlight while the menu is open (goal
  // support or a thread's metadata answering): it stays on its row, so Enter
  // does what was highlighted.
  it("keeps the highlighted row when commands come in above it", async () => {
    stubSkills([]);
    const onBrowse = vi.fn();
    const { rerender } = render(
      <Composer
        commands={MODEL_MENU_COMMANDS}
        onBrowse={onBrowse}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("ArrowUp");
    rerender(
      <Composer
        commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]}
        onBrowse={onBrowse}
      />
    );
    await waitFor(() => expect(options()).toHaveLength(7));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[6].id
    );
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect((box() as HTMLTextAreaElement).value).toBe("/");
  });

  it("keeps a highlighted skill when commands come in above it", async () => {
    stubSkills();
    const { rerender } = render(<Composer commands={MODEL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(4));
    key("ArrowDown");
    key("ArrowDown");
    rerender(
      <Composer commands={[...GOAL_MENU_COMMANDS, ...MODEL_MENU_COMMANDS]} />
    );
    await waitFor(() => expect(options()).toHaveLength(9));
    key("Enter");
    expect((box() as HTMLTextAreaElement).value).toBe("/paper-writing ");
  });

  // Commands keep the menu open before the skills are read and after a failed
  // read: the status doesn't count skills it doesn't know.
  it("counts no skills before they are read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    render(<Composer commands={MODEL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(screen.getByRole("status").textContent).toBe("1 command");
  });

  it("counts no skills after a failed read", async () => {
    stubSkills("error");
    render(<Composer commands={MODEL_MENU_COMMANDS} />);
    type("/");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => {});
    expect(options()).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("1 command");
  });

  // Nothing installed and a bare "/": the way to the marketplace stays, as
  // the last row after the commands (/model's row is on every backend, so
  // without this it would never show).
  it("offers the marketplace after the commands when no skill is installed", async () => {
    stubSkills([]);
    const onBrowse = vi.fn();
    render(
      <Composer
        commands={GOAL_MENU_COMMANDS}
        onBrowse={onBrowse}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(6));
    expect(options()[5]).toContain("No skills installed");
    expect(screen.getByRole("status").textContent).toBe(
      "5 commands, no skills installed"
    );
    // The first row is still a command.
    key("Enter");
    expect((box() as HTMLTextAreaElement).value).toBe("/goal ");
    expect(onBrowse).not.toHaveBeenCalled();
    type("/");
    await waitFor(() => expect(options()).toHaveLength(6));
    key("ArrowUp");
    const last = screen.getAllByRole("option")[5];
    expect(box().getAttribute("aria-activedescendant")).toBe(last.id);
    expect(last.getAttribute("aria-selected")).toBe("true");
    // Tab inserts nothing there; Enter goes to the marketplace.
    key("Tab");
    expect((box() as HTMLTextAreaElement).value).toBe("/");
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect((box() as HTMLTextAreaElement).value).toBe("/");
    // Only for a bare slash.
    type("/g");
    await waitFor(() => expect(options()).toHaveLength(5));
    expect(options().some((o) => o.includes("marketplace"))).toBe(false);
  });
});
