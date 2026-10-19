"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { applySkill, rankSkills, slashTokenAt } from "@/lib/slashMenu";

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
}) {
  const listboxId = useId();
  // Ids by name, so the active option's id changes with the match and a
  // screen reader announces it.
  const optionId = useCallback(
    (name: string | null) =>
      name === null ? `${listboxId}-browse` : `${listboxId}-skill-${name}`,
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
  });
  const request = useRef(0);

  const token =
    !disabled && focused && !composing && caret !== null
      ? slashTokenAt(value, caret)
      : null;
  const key = token ? `${token.start}:${token.query}` : null;
  const items =
    token && skills ? rankSkills(skills, token.query, token.pinned) : [];
  // Nothing installed: a bare `/` points to the marketplace instead.
  const empty =
    token !== null &&
    skills?.length === 0 &&
    token.query === "" &&
    token.pinned.length === 0;
  // Shut after an Escape until the word changes.
  const wanted = token !== null && key !== dismissed;
  const open = wanted && (items.length > 0 || empty);
  const active =
    activeState.key === key
      ? Math.min(activeState.index, Math.max(items.length - 1, 0))
      : 0;
  const activeId = !open
    ? undefined
    : empty
    ? optionId(null)
    : optionId(items[active].name);

  // Read the list each time the menu opens, an Escape's reopening included,
  // and show only that answer: a skill installed or removed a moment ago is
  // right, a failed read leaves the menu shut, and the last answer wins over
  // a slower earlier one.
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
        // A failed read leaves the menu shut.
      });
  }, [wanted, focusCount, workspaceSkills]);

  // An Escape holds only while the word it closed on stays as it was.
  useEffect(() => {
    if (dismissed !== null && dismissed !== key) setDismissed(null);
  }, [dismissed, key]);

  const pick = (index: number) => {
    const skill = items[index];
    if (!token || !skill) return;
    const next = applySkill(value, token, skill.name);
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
    onBrowse?.();
  };

  // The key handler reads the latest render, so it can stay one function.
  const latest = useRef({ open, empty, items, active, key, pick, browse });
  useLayoutEffect(() => {
    latest.current = { open, empty, items, active, key, pick, browse };
  });
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const { open, empty, items, active, key, pick, browse } = latest.current;
      // Keys with modifiers (Cmd+Enter, Shift+↓ …) stay the composer's.
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (items.length > 0) {
          const step = e.key === "ArrowDown" ? 1 : -1;
          setActiveState({
            key,
            index: (active + step + items.length) % items.length,
          });
        }
      } else if (e.key === "Enter") {
        if (empty) browse();
        else pick(active);
      } else if (e.key === "Tab" && !empty) {
        pick(active);
      } else if (e.key === "Escape") {
        setDismissed(key);
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
      items,
      active,
      empty,
      onPick: pick,
      onHover: (index: number) => setActiveState({ key, index }),
      onBrowse: browse,
    },
  };
}
