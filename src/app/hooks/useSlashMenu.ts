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
  rankSkills,
  slashTokenAt,
  type MenuPage,
  type MenuRow,
} from "@/lib/slashMenu";
import { PY_SPACE } from "@/lib/pythonWhitespace";

const NO_PAGES: readonly MenuPage[] = [];
// No highlight remembered: the next opening starts on its first row.
const NO_ACTIVE = {
  key: null as string | null,
  index: 0,
  row: null as string | null,
};

/** An installed skill the backend can pin (`GET /api/skills/pinnable`). */
export interface MenuSkill {
  name: string;
  description: string;
  source: "workspace" | "global";
}

/** What the menu shows: the commands' pages and the skills, or one page. */
export type SlashView =
  | {
      kind: "root";
      pages: readonly MenuPage[];
      skills: readonly MenuSkill[];
      marketplace: boolean;
    }
  | {
      kind: "page";
      page: MenuPage;
      rows: readonly MenuRow[];
      filter: string;
    };

interface OpenPage {
  word: string;
  /** The typed word the page took out of the composer (with the whitespace
   *  after it), to put back on the way back; null when opened by its word.
   *  `after` is the composer's text without it: text that changed since
   *  (a message handed back) gets nothing put back. */
  token: { at: number; text: string; word: string; after: string } | null;
}

/** What a page's filter takes from composed or pasted text: its first line. */
const firstLine = (text: string) => text.split(/\r\n|\r|\n/)[0];

/** The length of the whitespace run at `text`'s start (Python's). */
function leadingSpace(text: string): number {
  let n = 0;
  while (n < text.length && PY_SPACE.test(text[n])) n++;
  return n;
}

/**
 * The composer's `/` menu: while the caret ends a `/name` the backend would pin
 * (the message's leading `/name`s), list the commands' pages and the installed
 * skills that match. A page row opens its page, whose rows run when chosen; a
 * skill goes to `onPickSkill`. Wire `onChange`, `onKeyDown` (it returns true
 * when it took the key) and `textareaProps` into the textarea, and `menuProps`
 * into `SlashSkillMenu`.
 */
export function useSlashMenu({
  textareaRef,
  value,
  setValue,
  disabled = false,
  workspaceSkills = true,
  onBrowse,
  pages = NO_PAGES,
  onPickSkill,
  leadSkill = null,
  wantSkills = false,
  onSkillsRead,
  commandWords,
  rootMenu = true,
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
  /** The commands, each a page, offered above the skills as the message's
   *  first word. */
  pages?: readonly MenuPage[];
  /** A skill chosen: `rest` is the text without the typed word (and the
   *  whitespace after it); `from` is where its row was, for the chip to
   *  come from. */
  onPickSkill: (name: string, rest: string, from: DOMRect | null) => void;
  /** The skill the composer's chip pins: not offered again. */
  leadSkill?: string | null;
  /** Read the installed skills once outside the menu while true (the
   *  composer's text may start with one). */
  wantSkills?: boolean;
  /** Every list read, menu or not: the names a chip can show. */
  onSkillsRead?: (names: ReadonlySet<string>) => void;
  /** Words that are commands, never pins (a whole one shuts the menu);
   *  default: the pages' words. "goal" stays one while goal support is
   *  unknown. */
  commandWords?: readonly string[];
  /** Whether a leading `/` typed in the box opens the menu: off, it stays
   *  text (goal mode, where the box holds the goal); a page still opens
   *  with `openPage`. */
  rootMenu?: boolean;
}) {
  const listboxId = useId();
  // Ids by name, so the active option's id changes with the match and a
  // screen reader announces it.
  const optionId = useCallback(
    (name: string | null) =>
      name === null ? `${listboxId}-browse` : `${listboxId}-skill-${name}`,
    [listboxId]
  );
  const pageId = useCallback(
    (word: string) => `${listboxId}-page-${word}`,
    [listboxId]
  );
  const rowId = useCallback(
    (id: string) => `${listboxId}-row-${id}`,
    [listboxId]
  );
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  // Read in the same event the composition starts or ends in.
  const composingRef = useRef(false);
  // On a page, the composer's text and caret when a composition began: what
  // is composed goes to the filter, and the text comes back as it was.
  const composeBase = useRef<{ value: string; caret: number } | null>(null);
  // Counts the composer's focus events: each reads the list again, so a skill
  // installed while the chat was hidden shows when the composer is back.
  const [focusCount, setFocusCount] = useState(0);
  const [skills, setSkills] = useState<MenuSkill[] | null>(null);
  // Escape closes the menu for what was typed; typing on opens it again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeState, setActiveState] = useState(NO_ACTIVE);
  const [page, setPage] = useState<OpenPage | null>(null);
  // What is typed on a page: the page's, not the composer's.
  const [filter, setFilter] = useState("");
  const request = useRef(0);
  // The menu's read in flight: a highlighted skill waits for it, not longer.
  const [reading, setReading] = useState(false);
  // Every read in order, menu or not: only a newer list is reported.
  const readSeq = useRef(0);
  const reported = useRef(0);
  const reportRead = useRef(onSkillsRead);
  useLayoutEffect(() => {
    reportRead.current = onSkillsRead;
  });

  const pageDef = page ? pages.find((p) => p.word === page.word) : undefined;
  const usable = !disabled && focused;

  // The root: pages and skills for the word being typed.
  const token =
    rootMenu && !pageDef && usable && !composing && caret !== null
      ? slashTokenAt(
          value,
          caret,
          new Set(commandWords ?? pages.map((p) => p.word))
        )
      : null;
  const rootKey = token ? `${token.start}:${token.query}` : null;
  const pinned = token
    ? leadSkill
      ? [leadSkill, ...token.pinned]
      : token.pinned
    : [];
  const items = token && skills ? rankSkills(skills, token.query, pinned) : [];
  // A command is a message's first word ("/goal"), offered while the typed
  // word starts it; slashTokenAt closes the menu once it is whole.
  const pageItems =
    token && token.pinned.length === 0
      ? pages.filter((p) => p.word.startsWith(token.query))
      : NO_PAGES;
  // Nothing installed and a bare `/`: the way to the marketplace, as the last
  // row after any pages.
  const marketplace =
    token !== null &&
    skills?.length === 0 &&
    token.query === "" &&
    token.pinned.length === 0;

  // A page: its rows for what is typed on it.
  const pageRows = pageDef ? pageDef.rows(filter) : [];
  const key = pageDef ? `page:${pageDef.word}\n${filter}` : rootKey;
  // Each row's identity, in index order.
  const rows = pageDef
    ? pageRows.map((r) => `row:${r.id}`)
    : [
        ...pageItems.map((p) => `page:${p.word}`),
        ...items.map((s) => `skill:${s.name}`),
        ...(marketplace ? ["marketplace"] : []),
      ];
  const count = rows.length;
  const marketplaceIndex = !pageDef && marketplace ? count - 1 : -1;
  // Shut after an Escape until the word changes.
  const wanted = token !== null && rootKey !== dismissed;
  // One opening of the menu, its pages included: going to a page and back
  // reads nothing again.
  const session = wanted || !!pageDef;
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  // A page stays open with nothing matching: it says so.
  const open = pageDef ? usable : wanted && count > 0;
  // One index over the rows. The highlight follows its row; only a row that
  // went falls back to its place. A page starts on its initial row.
  // The initial row is the opening's; a filter starts on its first match.
  const initialIndex =
    pageDef?.initial !== undefined && filter === ""
      ? Math.max(0, rows.indexOf(`row:${pageDef.initial}`))
      : 0;
  const kept =
    activeState.key === key && activeState.row !== null
      ? rows.indexOf(activeState.row)
      : -1;
  const active =
    activeState.key !== key
      ? initialIndex
      : kept >= 0
      ? kept
      : Math.min(activeState.index, Math.max(count - 1, 0));
  const activeRow = open ? rows[active] : undefined;
  const activeId =
    activeRow === undefined
      ? undefined
      : activeRow === "marketplace"
      ? optionId(null)
      : activeRow.startsWith("page:")
      ? pageId(activeRow.slice("page:".length))
      : activeRow.startsWith("skill:")
      ? optionId(activeRow.slice("skill:".length))
      : rowId(activeRow.slice("row:".length));
  // A focus reads the list again: until it is back, a highlighted skill
  // isn't in the rows, and Enter would act on whatever row took its place.
  const rereading =
    reading &&
    skills === null &&
    activeState.key === key &&
    !!activeState.row?.startsWith("skill:");

  const url = workspaceSkills
    ? "/api/skills/pinnable"
    : "/api/skills/pinnable?workspace=0";
  const readSkills = useCallback(async (): Promise<MenuSkill[] | null> => {
    const id = ++readSeq.current;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { skills?: unknown };
      const list = Array.isArray(data.skills)
        ? (data.skills as MenuSkill[])
        : [];
      // An older read answering after a newer one isn't news.
      if (id > reported.current) {
        reported.current = id;
        reportRead.current?.(new Set(list.map((s) => s.name)));
      }
      return list;
    } catch {
      return null;
    }
  }, [url]);

  // Read the list each time the menu opens, an Escape's reopening included,
  // and show only that answer: a skill installed or removed a moment ago is
  // right, a failed read shows no skills (only pages, if any match), and the
  // last answer wins over a slower earlier one.
  useEffect(() => {
    if (!session) return;
    setSkills(null);
    setReading(true);
    const id = ++request.current;
    void readSkills().then((list) => {
      if (id !== request.current) return;
      setReading(false);
      if (list) setSkills(list);
    });
  }, [session, focusCount, readSkills]);

  // Outside the menu: the names a chip for the composer's text needs, read
  // when asked and again at each focus (a skill removed meanwhile drops its
  // chip). An open menu reads for itself.
  useEffect(() => {
    if (!wantSkills || sessionRef.current) return;
    void readSkills();
  }, [wantSkills, focusCount, readSkills]);

  // An Escape holds only while the word it closed on stays as it was.
  useEffect(() => {
    if (dismissed !== null && dismissed !== rootKey) setDismissed(null);
  }, [dismissed, rootKey]);

  // So does a highlight: a new word, a new filter or the menu closing starts
  // the next opening on its first row (a bare "/" typed again is a new
  // opening). Rows coming in while the word stays keep it (it follows its row).
  useEffect(() => {
    if (activeState.key !== null && activeState.key !== key) {
      setActiveState(NO_ACTIVE);
    }
  }, [activeState.key, key]);

  // A caret to place once the text it belongs to is in the box, before the
  // browser paints. The key that moved the text also reports the caret it
  // left (React's select event, in the same batch): that report is ignored
  // (onSelect) and this one wins.
  const pendingCaret = useRef<number | null>(null);
  const [placing, setPlacing] = useState(0);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(at, at);
    setCaret(at);
  }, [placing, textareaRef]);
  const placeCaret = (at: number) => {
    setCaret(at);
    pendingCaret.current = at;
    setPlacing((n) => n + 1);
  };

  const closePage = () => {
    setPage(null);
    setFilter("");
  };

  // Out of a page with the typed word put back where it was (unless the
  // composer's text changed meanwhile: the word's place is gone). Returns
  // where the root's highlight would go.
  const leavePage = (): { key: string; row: string } | null => {
    if (!page) return null;
    closePage();
    const t = page.token;
    if (!t || value !== t.after) return null;
    setValue(value.slice(0, t.at) + t.text + value.slice(t.at));
    placeCaret(t.at + t.word.length);
    return { key: `${t.at}:${t.word.slice(1)}`, row: `page:${page.word}` };
  };

  // A page that can't stay (its command went, the composer was disabled)
  // leaves as going back does.
  const pageGone = !!page && (!pageDef || disabled);
  const leaveRef = useRef(leavePage);
  useLayoutEffect(() => {
    leaveRef.current = leavePage;
  });
  useEffect(() => {
    if (pageGone) leaveRef.current();
  }, [pageGone]);

  // A page row: the page takes the typed word (and the whitespace after it)
  // out of the composer, keeping it to put back.
  const openFromToken = (word: string) => {
    if (!token) return;
    const end = token.end + leadingSpace(value.slice(token.end));
    const after = value.slice(0, token.start) + value.slice(end);
    setValue(after);
    setPage({
      word,
      token: {
        at: token.start,
        text: value.slice(token.start, end),
        word: value.slice(token.start, token.end),
        after,
      },
    });
    setFilter("");
    setActiveState(NO_ACTIVE);
    placeCaret(token.start);
  };

  // A page opened over another keeps the word that one took out, to give it
  // back on the way out.
  const openPage = (word: string) => {
    if (!pages.some((p) => p.word === word)) return;
    setPage({ word, token: page?.token ?? null });
    setFilter("");
    setActiveState(NO_ACTIVE);
  };

  // Shut, a page included, its word left out: the root doesn't reopen on it
  // (the model pill's second click).
  const closeMenu = () => {
    if (page) closePage();
    else setDismissed(rootKey);
    setActiveState(NO_ACTIVE);
  };

  // Back to the root: the typed word returns, with the page's row
  // highlighted. A page opened by its word just closes, and so does one
  // whose composer text changed meanwhile (the word's place is gone).
  const back = () => {
    const root = leavePage();
    setActiveState(root ? { ...root, index: 0 } : NO_ACTIVE);
  };

  const pickSkill = (name: string) => {
    if (!token) return;
    // One skill a message: the pick replaces the pins typed before it.
    const end = token.end + leadingSpace(value.slice(token.end));
    const rest = value.slice(end);
    const from =
      document.getElementById(optionId(name))?.getBoundingClientRect() ?? null;
    onPickSkill(name, rest, from);
    // Typing goes on where the word was (the start, where a chip shows the
    // skill), once the caller's text is in the box.
    placeCaret(token.start);
  };

  // On the way to the marketplace the menu closes, as with Escape.
  const browse = () => {
    setDismissed(rootKey);
    // An explicit close starts the next opening on the first row too.
    setActiveState(NO_ACTIVE);
    onBrowse?.();
  };

  // Enter, Tab and a click choose; a page's row runs once the menu is shut.
  const choose = (index: number) => {
    if (pageDef) {
      const row = pageRows[index];
      if (!row) return;
      closePage();
      setActiveState(NO_ACTIVE);
      row.run();
      return;
    }
    const id = rows[index];
    if (!id) return;
    if (id === "marketplace") browse();
    else if (id.startsWith("page:")) openFromToken(id.slice("page:".length));
    else pickSkill(id.slice("skill:".length));
  };

  // The key handler reads the latest render, so it can stay one function.
  const latest = useRef({
    open,
    onPage: !!pageDef,
    filter,
    rows,
    count,
    active,
    key,
    marketplaceIndex,
    rootKey,
    rereading,
    choose,
    back,
  });
  useLayoutEffect(() => {
    latest.current = {
      open,
      onPage: !!pageDef,
      filter,
      rows,
      count,
      active,
      key,
      marketplaceIndex,
      rootKey,
      rereading,
      choose,
      back,
    };
  });
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const L = latest.current;
      // Keys with modifiers (Cmd+Enter, Alt+↓ …) stay the composer's.
      if (!L.open || e.nativeEvent.isComposing) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const move = (step: number) => {
        if (L.count === 0) return;
        const index = (L.active + step + L.count) % L.count;
        setActiveState({ key: L.key, index, row: L.rows[index] });
      };
      if (L.onPage) {
        // Nothing typed on a page reaches the composer: a printable key
        // filters the page (Shift for capitals), Delete and Shift+Enter do
        // nothing. Shift+Tab still moves the focus on.
        if (e.key.length === 1) {
          setFilter(L.filter + e.key);
        } else if (e.key === "Enter") {
          if (!e.shiftKey) L.choose(L.active);
        } else if (e.key === "Delete") {
          // Nothing to delete forward on a page.
        } else if (e.shiftKey) {
          return false;
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          move(e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Tab") {
          L.choose(L.active);
        } else if (e.key === "ArrowLeft" || e.key === "Escape") {
          L.back();
        } else if (e.key === "Backspace") {
          if (L.filter) setFilter(L.filter.slice(0, -1));
          else L.back();
        } else {
          return false;
        }
        e.preventDefault();
        return true;
      }
      if (e.shiftKey) return false;
      const row = L.rows[L.active] ?? "";
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        // Wait for a re-read rather than act on the row in its place.
        if (!L.rereading) L.choose(L.active);
      } else if (e.key === "Tab" && L.active !== L.marketplaceIndex) {
        if (!L.rereading) L.choose(L.active);
      } else if (e.key === "ArrowRight" && row.startsWith("page:")) {
        if (!L.rereading) L.choose(L.active);
      } else if (e.key === "Escape") {
        setDismissed(L.rootKey);
        setActiveState(NO_ACTIVE);
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
    // A composition on a page goes to its filter when it ends; any other
    // change of the composer's text (a drop, say) is the composer's: the
    // page closes.
    if (page && !composingRef.current) closePage();
  };

  const view: SlashView = pageDef
    ? { kind: "page", page: pageDef, rows: pageRows, filter }
    : { kind: "root", pages: pageItems, skills: items, marketplace };

  return {
    onChange,
    onKeyDown,
    openPage,
    closeMenu,
    /** Put the caret at `at` once the caller's new text is in the box. */
    placeCaret,
    textareaProps: {
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        // The menu is placing the caret: the select the same key reports
        // is the old text's (a moment without the word would reset the
        // highlight).
        if (pendingCaret.current !== null) return;
        setCaret(e.currentTarget.selectionStart);
      },
      onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => {
        setFocused(true);
        setCaret(e.currentTarget.selectionStart);
        // A fresh focus starts fresh, as after a blur: an Escape or a trip to
        // the marketplace holds until then (a hidden column may not blur).
        setDismissed(null);
        setFocusCount((n) => n + 1);
      },
      onBlur: () => {
        setFocused(false);
        // A page closes with the focus and never reopens by itself. Its word
        // comes back only into an empty box: with a draft the focus may be
        // on its way to Send, which must send what shows.
        if (page?.token && page.token.after.trim()) closePage();
        else leavePage();
      },
      onCompositionStart: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        composingRef.current = true;
        setComposing(true);
        if (page) {
          composeBase.current = {
            value,
            caret: e.currentTarget.selectionStart,
          };
        }
      },
      onCompositionEnd: (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        composingRef.current = false;
        setComposing(false);
        setCaret(e.currentTarget.selectionStart);
        const base = composeBase.current;
        composeBase.current = null;
        if (!page || !base) return;
        // What was composed on a page is its filter's; the composer's text
        // comes back as it was. Text that changed otherwise meanwhile (a
        // message handed back) stays, and the page closes. The box is read,
        // not the last change: Firefox ends a composition before its last
        // input.
        const composed = e.data ?? "";
        const expected =
          base.value.slice(0, base.caret) +
          composed +
          base.value.slice(base.caret);
        const now = e.currentTarget.value;
        if (now !== expected && now !== base.value) {
          closePage();
          return;
        }
        setFilter((f) => f + firstLine(composed));
        setValue(base.value);
        placeCaret(base.caret);
      },
      onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (!page) return;
        e.preventDefault();
        setFilter((f) => f + firstLine(e.clipboardData.getData("text")));
      },
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? listboxId : undefined,
      "aria-activedescendant": activeId,
    },
    menuProps: {
      open,
      listboxId,
      optionId,
      pageId,
      rowId,
      activeId,
      active,
      view,
      skillsKnown: skills !== null,
      onChoose: choose,
      onHover: (index: number) =>
        setActiveState({ key, index, row: rows[index] ?? null }),
      onBack: back,
      onBrowse: browse,
    },
  };
}
