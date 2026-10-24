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
import type { MenuPage, MenuRow } from "@/lib/slashMenu";

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
// took the key, as ChatInterface wires it. A picked skill goes first, in
// place of the typed word (ChatInterface's chip replaces any other).
function Composer({
  onSubmit = () => {},
  onBrowse = () => {},
  disabled = false,
  pages,
  onPickSkill,
  leadSkill,
  wantSkills,
  onSkillsRead,
  apiRef,
}: {
  onSubmit?: (value: string) => void;
  onBrowse?: () => void;
  disabled?: boolean;
  pages?: readonly MenuPage[];
  onPickSkill?: (name: string, rest: string, from: DOMRect | null) => void;
  leadSkill?: string | null;
  wantSkills?: boolean;
  onSkillsRead?: (names: ReadonlySet<string>) => void;
  apiRef?: { current: ReturnType<typeof useSlashMenu> | null };
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
    pages,
    leadSkill,
    wantSkills,
    onSkillsRead,
    onPickSkill: (name, rest, from) => {
      onPickSkill?.(name, rest, from);
      setValue(`/${name} ${rest}`);
    },
  });
  if (apiRef) apiRef.current = slash;
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
// Text with the caret placed inside it, as a click there leaves it. React
// reports a selection only once the mouse is up (a test's mousedown on a row
// leaves it down), so the click ends with one.
const typeAt = (text: string, caret: number) => {
  act(() => box().focus());
  const el = box() as HTMLTextAreaElement;
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(caret, caret);
  fireEvent.mouseUp(el);
  fireEvent.select(el);
};
const value = () => (box() as HTMLTextAreaElement).value;
const activeOption = () =>
  document.getElementById(box().getAttribute("aria-activedescendant") ?? "");

// Two pages the way ChatInterface describes them: rows from the page's
// state, filtered by what is typed on the page.
function testPages() {
  const runs = {
    pause: vi.fn(),
    clear: vi.fn(),
    a: vi.fn(),
    b: vi.fn(),
    c: vi.fn(),
  };
  const goal: MenuPage = {
    word: "goal",
    label: "Goal",
    icon: "goal",
    description: "Active · Write hello",
    status: "Write hello · active",
    rows: (filter) =>
      (
        [
          {
            id: "pause",
            label: "Pause",
            description: "Stop working toward the goal for now",
            icon: "pause",
            run: runs.pause,
          },
          {
            id: "clear",
            label: "Clear",
            description: "Drop the goal and its criteria",
            icon: "clear",
            danger: true,
            run: runs.clear,
          },
        ] satisfies MenuRow[]
      ).filter((r) => r.label.toLowerCase().includes(filter.toLowerCase())),
    empty: (f) => `Nothing here matches “${f}”.`,
  };
  const model: MenuPage = {
    word: "model",
    label: "Model",
    icon: "model",
    description: "Change the model for this chat",
    tail: "model-b",
    status: "Current: model-b",
    rows: (filter) =>
      (["a", "b", "c"] as const)
        .filter((n) => `model-${n}`.includes(filter.toLowerCase()))
        .map((n) => ({
          id: n,
          label: `model-${n}`,
          description: "provider",
          icon: n === "b" ? ("check" as const) : null,
          mono: true,
          run: runs[n],
        })),
    initial: "b",
    empty: (f) => `No models match “${f}”.`,
  };
  return { goal, model, runs, both: [goal, model] };
}

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

    // Tab picks too.
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Tab");
    expect((box() as HTMLTextAreaElement).value).toBe("/paper-review ");
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
    const menu = screen
      .getByRole("listbox")
      .closest<HTMLElement>('[data-slot="slash-menu"]')!;
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

describe("useSlashMenu pages", () => {
  it("lists the pages above the skills, each with a chevron", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    expect(
      screen.getByRole("listbox", { name: "Commands and skills" })
    ).toBeTruthy();
    expect(options()[0]).toContain("Goal");
    expect(options()[0]).toContain("Active · Write hello");
    expect(options()[1]).toContain("Model");
    expect(options()[1]).toContain("model-b");
    expect(options()[2]).toContain("/paper-review");
    const [goalRow, modelRow] = screen.getAllByRole("option");
    expect(goalRow.querySelector('[data-slot="chevron"]')).toBeTruthy();
    expect(modelRow.querySelector('[data-slot="chevron"]')).toBeTruthy();
  });

  it("offers a page while the typed word starts its word, as the first word only", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options()[0]).toContain("Goal");
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options().some((o) => o.startsWith("Goal"))).toBe(false);
    type("/paper-review /");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(options().some((o) => o.startsWith("Model"))).toBe(false);
  });

  it("shows no page rows without pages", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
  });

  it("opens a page with Enter, → or a click, and takes the typed word out", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    typeAt("/go hello", 3);
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(screen.getByRole("listbox", { name: "Goal" })).toBeTruthy();
    expect(options()).toHaveLength(2);
    expect(options()[0]).toContain("Pause");
    expect(value()).toBe("hello");
    key("Escape");
    expect(value()).toBe("/go hello");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("ArrowRight");
    expect(screen.getByRole("listbox", { name: "Goal" })).toBeTruthy();
    key("Escape");
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(screen.getByRole("listbox", { name: "Goal" })).toBeTruthy();
  });

  it("opens a page on its initial row", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(activeOption()?.textContent).toContain("model-b");
    expect(activeOption()?.getAttribute("aria-selected")).toBe("true");
  });

  it("goes back with ← or Escape, puts the word back, and highlights the page's row", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    key("ArrowDown");
    key("Enter");
    expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
    expect(value()).toBe("");
    key("ArrowLeft");
    expect(value()).toBe("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    expect(activeOption()?.textContent).toContain("Model");
  });

  it("filters a page with typed keys, without touching the composer", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    // Taken by the page: the key does nothing in the composer.
    expect(key("c")).toBe(false);
    expect(options()).toEqual([expect.stringContaining("model-c")]);
    expect(value()).toBe("");
    expect(key("C", { shiftKey: true })).toBe(false);
    expect(options()).toHaveLength(0);
    key("Backspace");
    key("Backspace");
    expect(options()).toHaveLength(3);
    expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
    // An empty filter: Backspace goes back.
    key("Backspace");
    expect(value()).toBe("/mo");
  });

  it("runs a page row with Enter, Tab or a click, and closes the menu", async () => {
    stubSkills();
    const { both, runs } = testPages();
    render(<Composer pages={both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    key("Enter");
    expect(runs.pause).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(value()).toBe("");
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    key("ArrowDown");
    key("Tab");
    expect(runs.clear).toHaveBeenCalledTimes(1);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(runs.pause).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says when nothing on the page matches the filter", async () => {
    stubSkills();
    const { both, runs } = testPages();
    render(<Composer pages={both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    key("z");
    key("z");
    expect(screen.getByText("No models match “zz”.")).toBeTruthy();
    expect(options()).toHaveLength(0);
    // Enter stays the menu's, and nothing runs.
    expect(key("Enter")).toBe(false);
    expect(Object.values(runs).every((r) => r.mock.calls.length === 0)).toBe(
      true
    );
  });

  it("updates a page's rows in place and keeps the highlight on its row", async () => {
    stubSkills();
    const fx = testPages();
    const { rerender } = render(<Composer pages={fx.both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(activeOption()?.textContent).toContain("model-b");
    const answered: MenuPage = {
      ...fx.model,
      rows: (filter) => [
        { id: "z", label: "model-z", run: vi.fn() },
        ...fx.model.rows(filter),
      ],
    };
    rerender(<Composer pages={[fx.goal, answered]} />);
    expect(options()).toHaveLength(4);
    expect(activeOption()?.textContent).toContain("model-b");
    key("Enter");
    expect(fx.runs.b).toHaveBeenCalledTimes(1);
  });

  it("closes a page when the composer's text changes or it loses focus", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    fireEvent.change(box(), { target: { value: "x" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    act(() => box().blur());
    expect(screen.queryByRole("listbox")).toBeNull();
    act(() => box().focus());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("passes keys through while an input method composes, on a page too", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(key("c", { isComposing: true })).toBe(true);
    expect(key("Backspace", { isComposing: true })).toBe(true);
    expect(options()).toHaveLength(3);
    expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
  });

  it("hands the chosen skill to onPickSkill with the text after its word", async () => {
    stubSkills();
    const onPickSkill = vi.fn();
    render(<Composer onPickSkill={onPickSkill} />);
    typeAt("/pa \u0085draft", 3);
    await waitFor(() => expect(options()).toHaveLength(2));
    key("Tab");
    expect(onPickSkill).toHaveBeenCalledWith(
      "paper-review",
      "draft",
      expect.objectContaining({ top: expect.any(Number) })
    );
    expect(value()).toBe("/paper-review draft");
  });

  it("leaves the chip's skill out of the list", async () => {
    stubSkills();
    render(<Composer leadSkill="paper-review" />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options().some((o) => o.includes("/paper-review"))).toBe(false);
  });

  it("treats goal as a command word only where a goal page is offered", async () => {
    stubSkills([
      ...SKILLS,
      { name: "goal", description: "A skill named goal", source: "global" },
    ]);
    const fx = testPages();
    const { rerender } = render(<Composer pages={[fx.model]} />);
    type("/goal");
    await waitFor(() =>
      expect(options()).toEqual([expect.stringContaining("/goal")])
    );
    rerender(<Composer pages={fx.both} />);
    type("/goal ");
    type("/goal");
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("waits for a re-read before Enter acts on a highlighted skill", async () => {
    const fetchMock = stubSkills();
    const onPickSkill = vi.fn();
    render(
      <Composer
        pages={testPages().both}
        onPickSkill={onPickSkill}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    key("ArrowDown");
    key("ArrowDown");
    expect(activeOption()?.textContent).toContain("/paper-review");
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    fireEvent.focus(box());
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(key("Enter")).toBe(false);
    expect(onPickSkill).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
    await act(async () =>
      answer(new Response(JSON.stringify({ skills: SKILLS })))
    );
    await waitFor(() => expect(options()).toHaveLength(5));
    key("Enter");
    expect(onPickSkill).toHaveBeenCalledWith(
      "paper-review",
      "",
      expect.anything()
    );
  });

  it("reads the skills once when asked outside the menu, and reports every read", async () => {
    const fetchMock = stubSkills();
    const onSkillsRead = vi.fn();
    const { rerender } = render(<Composer onSkillsRead={onSkillsRead} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(
      <Composer
        wantSkills
        onSkillsRead={onSkillsRead}
      />
    );
    await waitFor(() =>
      expect(onSkillsRead).toHaveBeenCalledWith(
        new Set(["paper-review", "paper-writing", "research-survey"])
      )
    );
    rerender(
      <Composer
        wantSkills
        onSkillsRead={onSkillsRead}
      />
    );
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Each opening reads the list and reports it too.
    type("/");
    await waitFor(() => expect(onSkillsRead).toHaveBeenCalledTimes(2));
  });

  it("opens a page by its word", async () => {
    stubSkills();
    const api = { current: null as ReturnType<typeof useSlashMenu> | null };
    render(
      <Composer
        pages={testPages().both}
        apiRef={api}
      />
    );
    act(() => {
      box().focus();
      api.current!.openPage("model");
    });
    expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
    expect(activeOption()?.textContent).toContain("model-b");
    // Nothing typed to put back: Escape closes.
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(value()).toBe("");
  });

  it("draws a page with a back button, its title and its status", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(screen.getByText("Write hello · active")).toBeTruthy();
    const back = screen.getByRole("button", {
      name: "Back to commands and skills",
    });
    // A mousedown that would move focus is held back.
    expect(fireEvent.mouseDown(back)).toBe(false);
    fireEvent.click(back);
    expect(value()).toBe("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    // What is typed on the page takes the status's place.
    key("p");
    expect(screen.queryByText("Write hello · active")).toBeNull();
    expect(screen.getByText("p")).toBeTruthy();
  });

  it("shows a page's note above its rows, outside the options", async () => {
    stubSkills();
    const fx = testPages();
    const noted: MenuPage = {
      ...fx.model,
      note: "Showing a curated list: the backend's model registry didn't load.",
    };
    render(<Composer pages={[fx.goal, noted]} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    const note = screen.getByText(noted.note!);
    expect(note.closest('[role="option"]')).toBeNull();
  });

  it("marks a danger row", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    const clear = screen.getAllByRole("option")[1];
    expect(clear.getAttribute("data-tone")).toBe("danger");
    expect(screen.getAllByRole("option")[0].getAttribute("data-tone")).toBe(
      null
    );
  });

  it("says what Enter does on the highlighted row", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    const hint = () => screen.getByText(/to choose/).textContent;
    expect(hint()).toBe("↑ ↓ to choose · Enter to open · Esc to close");
    key("ArrowDown");
    key("ArrowDown");
    expect(hint()).toBe("↑ ↓ to choose · Enter or Tab to add · Esc to close");
    key("ArrowUp");
    key("Enter");
    expect(hint()).toBe(
      "↑ ↓ to choose · Enter to select · Type to filter · ← to go back"
    );
  });

  it("tells screen readers what a page holds", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(screen.getByRole("status").textContent).toBe("Goal: 2 options");
    key("z");
    expect(screen.getByRole("status").textContent).toBe(
      "Goal: Nothing here matches “z”."
    );
  });

  // The pages and the skills sit under their own headings, with a rule
  // between them; the headings aren't options, so the keys skip them.
  it("groups the pages and the skills under their headings", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    const commands = screen.getByRole("group", { name: "Commands" });
    const skills = screen.getByRole("group", { name: "Skills" });
    expect(within(commands).getAllByRole("option")).toHaveLength(2);
    expect(within(skills).getAllByRole("option")).toHaveLength(3);
    expect(skills.className).toContain("border-t");
    expect(commands.className).not.toContain("border-t");
    key("ArrowDown");
    key("ArrowDown");
    expect(box().getAttribute("aria-activedescendant")).toBe(
      within(skills).getAllByRole("option")[0].id
    );
  });

  it("puts the way to the marketplace under Skills when none is installed", async () => {
    stubSkills([]);
    render(<Composer pages={[testPages().model]} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(
      within(screen.getByRole("group", { name: "Skills" })).getByRole("option")
        .textContent
    ).toContain("No skills installed");
  });

  it("shows only the headings with rows under them", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/pa");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(screen.queryByRole("group", { name: "Commands" })).toBeNull();
    expect(
      screen.getByRole("group", { name: "Skills" }).className
    ).not.toContain("border-t");
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(screen.queryByRole("group", { name: "Skills" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
  });

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
      render(<Composer pages={testPages().both} />);
      type("/");
      await waitFor(() => expect(options()).toHaveLength(5));
      key("ArrowDown");
      key("ArrowDown");
      await waitFor(() =>
        expect(scrolled.slice(-2)).toEqual([
          "Skills",
          expect.stringContaining("/paper-review"),
        ])
      );
      key("ArrowDown");
      await waitFor(() =>
        expect(scrolled[scrolled.length - 1]).toContain("/paper-writing")
      );
      expect(scrolled[scrolled.length - 2]).toContain("/paper-review");
      key("ArrowDown");
      key("ArrowDown");
      await waitFor(() =>
        expect(scrolled.slice(-2)).toEqual([
          "Commands",
          expect.stringContaining("Goal"),
        ])
      );
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it("marks every row with an icon and every skill with its source", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    const rows = screen.getAllByRole("option");
    expect(
      rows.every((row) => row.querySelector('svg[aria-hidden="true"]'))
    ).toBe(true);
    expect(rows[2].textContent).toContain("Global");
    expect(rows[3].textContent).toContain("Workspace");
  });

  // On a narrow screen a long name gives way (it truncates) before the
  // skill's source, and a page row's description before its tail.
  it("lets a long name give way before the skill's source", async () => {
    stubSkills();
    render(<Composer pages={[testPages().model]} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(4));
    const [pageRow, skillRow] = screen.getAllByRole("option");
    const name = skillRow.querySelector(":scope > span")!;
    expect(name.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-w-0", "truncate"])
    );
    expect(name.className).not.toContain("shrink-0");
    const spans = skillRow.querySelectorAll(":scope > span");
    expect(spans[spans.length - 1].className).toContain("shrink-0");
    const description = pageRow.querySelector('[data-slot="description"]')!;
    expect(description.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-w-0", "truncate"])
    );
    expect(pageRow.querySelector('[data-slot="tail"]')!.className).toContain(
      "shrink-0"
    );
  });

  it("starts each opening on the first row", async () => {
    stubSkills([]);
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    key("ArrowUp");
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[2].id
    );
    type("");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
  });

  it("starts on the first row after an Escape or the marketplace", async () => {
    const fetchMock = stubSkills([]);
    const onBrowse = vi.fn();
    render(
      <Composer
        pages={testPages().both}
        onBrowse={onBrowse}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    key("ArrowUp");
    key("ArrowUp");
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.focus(box());
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
    key("ArrowUp");
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ skills: [SKILLS[0]] }))
    );
    fireEvent.focus(box());
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id
    );
  });

  // globals.css gives every li a bottom margin: the menu's rows and headings
  // cancel it, so there is no dead strip between rows.
  it("leaves no gap between the menu's rows", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    const items = screen.getByRole("listbox").querySelectorAll("li");
    expect(items.length).toBeGreaterThan(5);
    for (const item of items) {
      expect(item.className.split(/\s+/)).toContain("mb-0");
    }
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    for (const item of screen.getByRole("listbox").querySelectorAll("li")) {
      expect(item.className.split(/\s+/)).toContain("mb-0");
    }
  });

  // Rows can come in above the highlight while the menu is open (goal
  // support or a thread's metadata answering): it stays on its row.
  it("keeps the highlighted row when pages come in above it", async () => {
    stubSkills([]);
    const onBrowse = vi.fn();
    const fx = testPages();
    const { rerender } = render(
      <Composer
        pages={[fx.model]}
        onBrowse={onBrowse}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("ArrowUp");
    rerender(
      <Composer
        pages={fx.both}
        onBrowse={onBrowse}
      />
    );
    await waitFor(() => expect(options()).toHaveLength(3));
    expect(box().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[2].id
    );
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(value()).toBe("/");
  });

  it("keeps a highlighted skill when pages come in above it", async () => {
    stubSkills();
    const fx = testPages();
    const { rerender } = render(<Composer pages={[fx.model]} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(4));
    key("ArrowDown");
    key("ArrowDown");
    rerender(<Composer pages={fx.both} />);
    await waitFor(() => expect(options()).toHaveLength(5));
    key("Enter");
    expect(value()).toBe("/paper-writing ");
  });

  // Pages keep the menu open before the skills are read and after a failed
  // read: the status doesn't count skills it doesn't know.
  it("counts no skills before they are read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    render(<Composer pages={[testPages().model]} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(screen.getByRole("status").textContent).toBe("1 command");
  });

  it("counts no skills after a failed read", async () => {
    stubSkills("error");
    render(<Composer pages={[testPages().model]} />);
    type("/");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => {});
    expect(options()).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("1 command");
  });

  // Nothing installed and a bare "/": the way to the marketplace stays, as
  // the last row after the pages (the Model page is on every backend).
  it("offers the marketplace after the pages when no skill is installed", async () => {
    stubSkills([]);
    const onBrowse = vi.fn();
    render(
      <Composer
        pages={[testPages().goal]}
        onBrowse={onBrowse}
      />
    );
    type("/");
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options()[1]).toContain("No skills installed");
    expect(screen.getByRole("status").textContent).toBe(
      "1 command, no skills installed"
    );
    // The first row is still the page.
    key("Enter");
    expect(screen.getByRole("listbox", { name: "Goal" })).toBeTruthy();
    expect(onBrowse).not.toHaveBeenCalled();
    key("Escape");
    await waitFor(() => expect(options()).toHaveLength(2));
    key("ArrowUp");
    const last = screen.getAllByRole("option")[1];
    expect(box().getAttribute("aria-activedescendant")).toBe(last.id);
    // Tab passes there; Enter goes to the marketplace.
    expect(key("Tab")).toBe(true);
    expect(value()).toBe("/");
    key("Enter");
    expect(onBrowse).toHaveBeenCalledTimes(1);
    type("/g");
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(options().some((o) => o.includes("marketplace"))).toBe(false);
  });
});

describe("useSlashMenu motion", () => {
  const leavingPage = () =>
    document.querySelector('[data-slot="slash-page"][data-leaving]');
  const menuBox = () => document.querySelector('[data-slot="slash-menu"]');

  it("hides a closing menu from assistive tech at once, and removes it after its fade", async () => {
    stubSkills();
    render(<Composer />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(3));
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(menuBox()?.getAttribute("aria-hidden")).toBe("true");
    expect(menuBox()?.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(menuBox()).toBeNull());
  });

  it("keeps the leaving page out of reach while the next slides in", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(screen.getByRole("listbox", { name: "Goal" })).toBeTruthy();
    expect(leavingPage()?.getAttribute("aria-hidden")).toBe("true");
    expect(leavingPage()?.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(leavingPage()).toBeNull());
  });

  it("acts on keys pressed during a transition", async () => {
    stubSkills();
    const { both, runs } = testPages();
    render(<Composer pages={both} />);
    type("/mo");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    key("ArrowDown");
    key("Enter");
    expect(runs.c).toHaveBeenCalledTimes(1);
  });

  it("skips the leaving layers when the user prefers reduced motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/go");
    await waitFor(() => expect(options()).toHaveLength(1));
    key("Enter");
    expect(leavingPage()).toBeNull();
    key("Escape");
    key("Escape");
    expect(menuBox()).toBeNull();
  });

  it("moves one highlight bar to the active option", async () => {
    stubSkills();
    render(<Composer pages={testPages().both} />);
    type("/");
    await waitFor(() => expect(options()).toHaveLength(5));
    const bars = screen
      .getByRole("listbox")
      .querySelectorAll('[data-slot="highlight"]');
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-hidden")).toBe("true");
    expect(
      screen
        .getAllByRole("option")
        .some((o) => o.className.includes("bg-accent"))
    ).toBe(false);
    expect(activeOption()?.getAttribute("aria-selected")).toBe("true");
  });
});
