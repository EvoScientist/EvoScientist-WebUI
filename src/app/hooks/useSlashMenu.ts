"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  applySkill,
  rankSkills,
  slashTokenAt,
  type MenuCommand,
} from "@/lib/slashMenu";
import { PY_SPACE } from "@/lib/pythonWhitespace";

const NO_COMMANDS: readonly MenuCommand[] = [];

/** An installed skill the backend can pin (`GET /api/skills/pinnable`). */
export interface MenuSkill {
  name: string;
  description: string;
  source: "workspace" | "global";
}

/**
 * The composer's `/` menu: while the caret ends a `/name` the backend would pin
 * (the message's leading `/name`s), list the installed skills that match, and
 * put the chosen name in place. Wire `onChange`, `onKeyDown` (it returns true
 * when it took the key) and `textareaProps` into the textarea, and
 * `menuProps` into `SlashSkillMenu`.
 */
export function useSlashMenu({
  textareaRef,
  value,
  setValue,
  disabled = false,
  workspaceSkills = true,
  onBrowse,
  commands = NO_COMMANDS,
  runnerFor,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (value: string) => void;
  disabled?: boolean;
  /** Offer the workspace's own skills: off when this machine's workspace
   *  isn't the backend's folder, leaving the global tier. */
  workspaceSkills?: boolean;
  /** Open the Skills marketplace (offered when none is installed). */
  onBrowse?: () => void;
  /** Commands offered above the skills as the message's first word. */
  commands?: readonly MenuCommand[];
  /** How to run a command that needs nothing more (`run`), chosen with Enter
   *  or a click: a function, or null where this composer can't run it (an
   *  ordinary row then: written out). It must not act itself: the hint asks
   *  it about the highlighted row on every render. */
  runnerFor?: (command: MenuCommand) => (() => void) | null;
}) {
  const listboxId = useId();
  // Ids by name, so the active option's id changes with the match and a
  // screen reader announces it.
  const optionId = useCallback(
    (name: string | null) =>
      name === null ? `${listboxId}-browse` : `${listboxId}-skill-${name}`,
    [listboxId]
  );
  const commandId = useCallback(
    (index: number) => `${listboxId}-command-${index}`,
    [listboxId]
  );
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  // Counts the composer's focus events: each reads the list again, so a skill
  // installed while the chat was hidden shows when the composer is back.
  const [focusCount, setFocusCount] = useState(0);
  const [skills, setSkills] = useState<MenuSkill[] | null>(null);
  // Escape closes the menu for what was typed; typing on opens it again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeState, setActiveState] = useState({
    key: null as string | null,
    index: 0,
    // The highlighted row itself, so the highlight stays on it when rows
    // come in above it (goal support or the skills answering while open).
    row: null as string | null,
  });
  const request = useRef(0);

  const token =
    !disabled && focused && !composing && caret !== null
      ? slashTokenAt(value, caret)
      : null;
  const key = token ? `${token.start}:${token.query}` : null;
  const items =
    token && skills ? rankSkills(skills, token.query, token.pinned) : [];
  // A command is a message's first word ("/goal …"), offered while the
  // typed word starts it; slashTokenAt closes the menu once it is whole.
  const commandItems =
    token && token.pinned.length === 0
      ? commands.filter((c) => c.word.startsWith(token.query))
      : NO_COMMANDS;
  // Nothing installed and a bare `/`: the way to the marketplace, as the last
  // row after any commands.
  const marketplace =
    token !== null &&
    skills?.length === 0 &&
    token.query === "" &&
    token.pinned.length === 0;
  // Each row's identity, in index order.
  const rows = [
    ...commandItems.map((c) => `command:${c.label}`),
    ...items.map((s) => `skill:${s.name}`),
    ...(marketplace ? ["marketplace"] : []),
  ];
  const count = rows.length;
  const marketplaceIndex = marketplace ? count - 1 : -1;
  // Shut after an Escape until the word changes.
  const wanted = token !== null && key !== dismissed;
  const open = wanted && count > 0;
  // One index over the commands, the skills, then the marketplace. The
  // highlight follows its row; only a row that went falls back to the place.
  const kept =
    activeState.key === key && activeState.row !== null
      ? rows.indexOf(activeState.row)
      : -1;
  const active =
    activeState.key !== key
      ? 0
      : kept >= 0
      ? kept
      : Math.min(activeState.index, Math.max(count - 1, 0));
  const activeId = !open
    ? undefined
    : active === marketplaceIndex
    ? optionId(null)
    : active < commandItems.length
    ? commandId(active)
    : optionId(items[active - commandItems.length].name);

  // A command runs when chosen only if it needs nothing more and this
  // composer can run it.
  const runnerOf = (command: MenuCommand | undefined) =>
    command?.run ? runnerFor?.(command) ?? null : null;
  const enterRuns =
    open && active < commandItems.length && !!runnerOf(commandItems[active]);

  // Read the list each time the menu opens, an Escape's reopening included,
  // and show only that answer: a skill installed or removed a moment ago is
  // right, a failed read shows no skills (only commands, if any match), and
  // the last answer wins over a slower earlier one.
  useEffect(() => {
    if (!wanted) return;
    setSkills(null);
    const id = ++request.current;
    fetch(
      workspaceSkills
        ? "/api/skills/pinnable"
        : "/api/skills/pinnable?workspace=0",
      { cache: "no-store" }
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: { skills?: unknown }) => {
        if (id !== request.current) return;
        setSkills(
          Array.isArray(data.skills) ? (data.skills as MenuSkill[]) : []
        );
      })
      .catch(() => {
        // A failed read shows no skills: the menu stays shut unless a
        // command matches.
      });
  }, [wanted, focusCount, workspaceSkills]);

  // An Escape holds only while the word it closed on stays as it was.
  useEffect(() => {
    if (dismissed !== null && dismissed !== key) setDismissed(null);
  }, [dismissed, key]);

  // So does a highlight: a new word, or the menu closing, starts the next
  // opening on the first row (a bare "/" typed again is a new opening).
  // Rows coming in while the word stays keep it (it follows its row).
  useEffect(() => {
    if (activeState.key !== null && activeState.key !== key) {
      setActiveState({ key: null, index: 0, row: null });
    }
  }, [activeState.key, key]);

  // Enter and a click choose; Tab writes the row out. A command that needs
  // nothing more (`run`) runs when chosen, if this composer can run it, and
  // its typed word goes.
  const pick = (index: number, choose = true) => {
    if (!token) return;
    const command = commandItems[index];
    const skill = items[index - commandItems.length];
    if (!command && !skill) return;
    const runner = choose ? runnerOf(command) : null;
    if (runner) {
      // The word goes with the separator slashTokenAt split on (Python's
      // whitespace), and the caret goes where the word was: the picker has
      // the focus, but typing on after it closes starts there.
      const rest = value.slice(token.end);
      let skip = 0;
      while (skip < rest.length && PY_SPACE.test(rest[skip])) skip++;
      setValue(value.slice(0, token.start) + rest.slice(skip));
      setCaret(token.start);
      const el = textareaRef.current;
      const at = token.start;
      requestAnimationFrame(() => el?.setSelectionRange(at, at));
      runner();
      return;
    }
    const next = command
      ? {
          text:
            value.slice(0, token.start) +
            command.insert +
            value.slice(token.end),
          caret: token.start + command.insert.length,
        }
      : applySkill(value, token, skill.name);
    setValue(next.text);
    setCaret(next.caret);
    const el = textareaRef.current;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  // On the way to the marketplace the menu closes, as with Escape.
  const browse = () => {
    setDismissed(key);
    // An explicit close starts the next opening on the first row too.
    setActiveState({ key: null, index: 0, row: null });
    onBrowse?.();
  };

  // The key handler reads the latest render, so it can stay one function.
  const latest = useRef({
    open,
    marketplaceIndex,
    rows,
    count,
    active,
    key,
    pick,
    browse,
  });
  useLayoutEffect(() => {
    latest.current = {
      open,
      marketplaceIndex,
      rows,
      count,
      active,
      key,
      pick,
      browse,
    };
  });
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const { open, marketplaceIndex, rows, count, active, key, pick, browse } =
        latest.current;
      // Keys with modifiers (Cmd+Enter, Shift+↓ …) stay the composer's.
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (count > 0) {
          const step = e.key === "ArrowDown" ? 1 : -1;
          const index = (active + step + count) % count;
          setActiveState({ key, index, row: rows[index] });
        }
      } else if (e.key === "Enter") {
        if (active === marketplaceIndex) browse();
        else pick(active);
      } else if (e.key === "Tab" && active !== marketplaceIndex) {
        pick(active, false);
      } else if (e.key === "Escape") {
        setDismissed(key);
        setActiveState({ key: null, index: 0, row: null });
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    },
    []
  );

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFocused(true);
    setCaret(e.target.selectionStart);
  };

  return {
    onChange,
    onKeyDown,
    textareaProps: {
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
        setCaret(e.currentTarget.selectionStart),
      onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => {
        setFocused(true);
        setCaret(e.currentTarget.selectionStart);
        // A fresh focus starts fresh, as after a blur: an Escape or a trip to
        // the marketplace holds until then (a hidden column may not blur).
        setDismissed(null);
        setFocusCount((n) => n + 1);
      },
      onBlur: () => setFocused(false),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        setComposing(false);
        setCaret(e.currentTarget.selectionStart);
      },
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listboxId : undefined,
      "aria-activedescendant": activeId,
    },
    menuProps: {
      open,
      listboxId,
      optionId,
      commandId,
      commands: commandItems,
      activeId,
      items,
      active,
      marketplace,
      enterRuns,
      skillsKnown: skills !== null,
      onPick: pick,
      onHover: (index: number) =>
        setActiveState({ key, index, row: rows[index] ?? null }),
      onBrowse: browse,
    },
  };
}
