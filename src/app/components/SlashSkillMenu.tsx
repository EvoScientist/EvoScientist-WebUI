"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Info,
  Pause,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RotateCcw,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { SlashView } from "@/app/hooks/useSlashMenu";
import type { MenuIcon } from "@/lib/slashMenu";
import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

// A command's icon is its pill's (the goal's target, the model's sparkles);
// a page's rows say what they do.
const ICONS: Record<MenuIcon, LucideIcon> = {
  goal: Target,
  model: Sparkles,
  check: Check,
  plus: Plus,
  pencil: Pencil,
  pause: Pause,
  play: Play,
  clear: CircleX,
  details: Info,
  reset: RotateCcw,
};
const ROW = "mb-0 flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm";
const ICON = "size-3.5 shrink-0 text-muted-foreground";
const HEADING =
  "mb-0 select-none px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground";
const LISTBOX = "relative m-0 max-h-96 min-h-0 overflow-y-auto px-0 py-1";
// A row is positioned, so it paints over the highlight bar behind it.
const OPTION = "relative";

// How long the menu fades out, a page slides out and the box eases
// (globals.css cuts the CSS side to nothing for reduced motion; the leaving
// layers and the ease are skipped). Each timer outlasts its animation a bit.
const EXIT_MS = 130;
const PAGE_MS = 220;
const HEIGHT_MS = 200;

// Gap to the composer, and the margin kept from the window's top edge.
const GAP = 6;
const EDGE = 8;

interface SlashSkillMenuProps {
  open: boolean;
  /** The composer box the menu sits above, at its width. */
  anchorRef: React.RefObject<HTMLElement | null>;
  listboxId: string;
  /** A skill option's id, by name (null: the marketplace option). */
  optionId: (name: string | null) => string;
  /** A page row's id on the root, by the command's word. */
  pageId: (word: string) => string;
  /** A row's id on a page, by the row's id. */
  rowId: (id: string) => string;
  /** The active option's id, as the textarea's aria-activedescendant. */
  activeId?: string;
  active: number;
  view: SlashView;
  /** Whether the skills were read: until then, and after a failed read, the
   *  status counts none rather than saying 0. */
  skillsKnown: boolean;
  onChoose: (index: number) => void;
  onHover: (index: number) => void;
  onBack: () => void;
  onBrowse?: () => void;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** What draws one view of the menu: the live one, or a snapshot of it while
 *  it leaves (a page sliding out, the menu fading). */
type Body = Pick<
  SlashSkillMenuProps,
  | "listboxId"
  | "optionId"
  | "pageId"
  | "rowId"
  | "activeId"
  | "active"
  | "view"
  | "onChoose"
  | "onHover"
  | "onBack"
  | "onBrowse"
>;

const viewKey = (view: SlashView) =>
  view.kind === "page" ? `page:${view.page.word}` : "root";

/** A view's own height, however tall the box around it is now: a list counts
 *  its rows (up to its max-height), the rest as laid out, and the whole fits
 *  the room the menu has (its max-height, less the hint row and borders). */
/** A list's rows as laid out: the bottom of its last child in the flow and
 *  its padding. Never its scroll height, which counts the highlight bar
 *  where it last stood (absolutely placed, moved by a transform). */
function rowsHeight(list: HTMLElement): number {
  let bottom = 0;
  for (const child of list.children) {
    const el = child as HTMLElement;
    if (el.dataset.slot === "highlight") continue;
    bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
  }
  const padding = parseFloat(getComputedStyle(list).paddingBottom);
  return bottom + (Number.isFinite(padding) ? padding : 0);
}

function naturalHeight(content: HTMLElement, viewport: HTMLElement): number {
  let total = 0;
  for (const child of content.children) {
    const el = child as HTMLElement;
    if (el.getAttribute("role") === "listbox") {
      const max = parseFloat(getComputedStyle(el).maxHeight);
      total += Math.min(rowsHeight(el), Number.isFinite(max) ? max : Infinity);
    } else {
      total += el.offsetHeight;
    }
  }
  const menu = viewport.parentElement;
  const room = menu
    ? parseFloat(menu.style.maxHeight) -
      (menu.offsetHeight - viewport.offsetHeight)
    : NaN;
  return Number.isFinite(room) ? Math.min(total, Math.max(room, 0)) : total;
}

/** What Enter does on the highlighted row. */
function hintFor({ view, active }: Body): string {
  if (view.kind === "page") {
    return "↑ ↓ to choose · Enter to select · Type to filter · ← to go back";
  }
  const marketplaceIndex = view.pages.length + view.skills.length;
  return (view.marketplace && active === marketplaceIndex) ||
    active < view.pages.length
    ? "↑ ↓ to choose · Enter to open · Esc to close"
    : "↑ ↓ to choose · Enter or Tab to add · Esc to close";
}

/** The rows of one view: the commands' pages and the skills, or a page's
 *  header and rows. The live view's highlight is one bar that glides to the
 *  active row; a leaving snapshot marks its active row in place. */
function MenuBody({
  body,
  live,
  barRef,
}: {
  body: Body;
  live: boolean;
  barRef?: React.Ref<HTMLDivElement>;
}) {
  const { view, active, listboxId, optionId, pageId, rowId } = body;
  const { onChoose, onHover, onBack, onBrowse } = body;
  const rowClass = (index: number) =>
    cn(ROW, OPTION, !live && index === active && "bg-accent");
  // Ids belong to the live view: a leaving snapshot carries none, so the
  // textarea's aria-controls and aria-activedescendant never reach it.
  const id = (value: string) => (live ? value : undefined);
  const bar = live && (
    <div
      ref={barRef}
      data-slot="highlight"
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1 top-0 rounded-md bg-accent opacity-0 transition-[transform,height,opacity] ease-out [transition-duration:120ms]"
    />
  );

  if (view.kind === "root") {
    const marketplaceIndex = view.pages.length + view.skills.length;
    return (
      // Commands and skills each under a heading, a rule between them (the
      // APG's grouped listbox: the headings are not options, so the keys skip
      // them).
      <div
        id={id(listboxId)}
        role="listbox"
        aria-label={
          view.pages.length === 0
            ? "Skills"
            : view.skills.length > 0 || view.marketplace
            ? "Commands and skills"
            : "Commands"
        }
        className={LISTBOX}
      >
        {bar}
        {view.pages.length > 0 && (
          <ul
            role="group"
            aria-labelledby={id(`${listboxId}-commands`)}
            className="m-0 list-none p-0"
          >
            <li
              role="presentation"
              id={id(`${listboxId}-commands`)}
              className={HEADING}
            >
              Commands
            </li>
            {view.pages.map((page, index) => {
              const Icon = ICONS[page.icon];
              return (
                <li
                  key={page.word}
                  id={id(pageId(page.word))}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onChoose(index)}
                  className={rowClass(index)}
                >
                  <Icon
                    className={ICON}
                    aria-hidden="true"
                  />
                  <span className="shrink-0 text-foreground">{page.label}</span>
                  {/* The description gives way first; the tail keeps its
                      place before the chevron. */}
                  <span
                    data-slot="description"
                    className="min-w-0 flex-1 truncate text-muted-foreground"
                  >
                    {page.description}
                  </span>
                  {page.tail && (
                    <span
                      data-slot="tail"
                      className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground"
                    >
                      {page.tail}
                    </span>
                  )}
                  <ChevronRight
                    data-slot="chevron"
                    className={ICON}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        )}
        {(view.skills.length > 0 || view.marketplace) && (
          <ul
            role="group"
            aria-labelledby={id(`${listboxId}-skills`)}
            className={cn(
              "m-0 list-none p-0",
              view.pages.length > 0 &&
                "mt-1 border-0 border-t border-solid border-border pt-1"
            )}
          >
            <li
              role="presentation"
              id={id(`${listboxId}-skills`)}
              className={HEADING}
            >
              Skills
            </li>
            {view.skills.map((skill, skillIndex) => {
              // One index over the pages, then the skills.
              const index = view.pages.length + skillIndex;
              return (
                <li
                  key={skill.name}
                  id={id(optionId(skill.name))}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onChoose(index)}
                  className={rowClass(index)}
                >
                  <Puzzle
                    className={ICON}
                    aria-hidden="true"
                  />
                  {/* A name too long for the row truncates; the source keeps
                      its place. */}
                  <span className="min-w-0 truncate font-mono text-foreground">
                    /{skill.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {skill.description}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {skill.source === "workspace" ? "Workspace" : "Global"}
                  </span>
                </li>
              );
            })}
            {view.marketplace && (
              <li
                id={id(optionId(null))}
                role="option"
                aria-selected={marketplaceIndex === active}
                onMouseEnter={() => onHover(marketplaceIndex)}
                onClick={onBrowse}
                className={cn(rowClass(marketplaceIndex), "py-2")}
              >
                <Puzzle
                  className={ICON}
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">
                  No skills installed. Browse the Skills marketplace
                </span>
              </li>
            )}
          </ul>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-0 border-b border-solid border-border py-1 pl-1.5 pr-3">
        <button
          type="button"
          aria-label="Back to commands and skills"
          onClick={onBack}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft
            className="size-4"
            aria-hidden="true"
          />
        </button>
        <span className="shrink-0 text-sm font-semibold text-foreground">
          {view.page.label}
        </span>
        {/* What is typed on the page takes the status's place. */}
        {view.filter ? (
          <span className="ml-auto min-w-0 truncate whitespace-pre rounded bg-[var(--brand-soft)] px-1.5 font-mono text-xs text-[var(--brand)]">
            {view.filter}
          </span>
        ) : view.page.status ? (
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
            {view.page.status}
          </span>
        ) : null}
      </div>
      {view.page.note && (
        <p className="m-0 shrink-0 px-3 pt-1.5 text-xs text-muted-foreground">
          {view.page.note}
        </p>
      )}
      <div
        id={id(listboxId)}
        role="listbox"
        aria-label={view.page.label}
        className={LISTBOX}
      >
        {bar}
        {view.rows.length > 0 && (
          <ul
            role="presentation"
            className="m-0 list-none p-0"
          >
            {view.rows.map((row, index) => {
              const Icon = row.icon ? ICONS[row.icon] : null;
              return (
                <li
                  key={row.id}
                  id={id(rowId(row.id))}
                  role="option"
                  aria-selected={index === active}
                  data-tone={row.danger ? "danger" : undefined}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onChoose(index)}
                  className={rowClass(index)}
                >
                  {Icon ? (
                    <Icon
                      className={cn(ICON, row.danger && "text-destructive")}
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={cn(
                      "max-w-[65%] shrink-0 truncate",
                      row.mono && "font-mono",
                      row.danger ? "text-destructive" : "text-foreground"
                    )}
                  >
                    {row.label}
                  </span>
                  {row.description && (
                    <span
                      data-slot="description"
                      className="min-w-0 flex-1 truncate text-muted-foreground"
                    >
                      {row.description}
                    </span>
                  )}
                  {row.tail && (
                    <span
                      data-slot="tail"
                      className="ml-auto shrink-0 text-xs text-muted-foreground"
                    >
                      {row.tail}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {view.rows.length === 0 && (
        <p className="m-0 shrink-0 px-3 pb-2 text-sm text-muted-foreground">
          {view.page.empty(view.filter)}
        </p>
      )}
    </>
  );
}

/**
 * The `/` menu (state in `useSlashMenu`): the commands' pages and the skills,
 * or one page's rows. It renders into the body, because the composer clips
 * what overflows it; focus stays in the textarea, which points at the active
 * option with `aria-activedescendant`. It fades in and out, a page slides in
 * over the one it leaves, the box eases to its new height and the highlight
 * glides; what leaves is out of reach (aria-hidden, inert) at once.
 */
export function SlashSkillMenu({
  open,
  anchorRef,
  skillsKnown,
  ...rest
}: SlashSkillMenuProps) {
  const body: Body = rest;
  const { view, activeId } = body;
  const key = viewKey(view);
  const reduced = prefersReducedMotion();
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  // What leaves: the menu while it fades, a page while the next slides in.
  const [closing, setClosing] = useState<Body | null>(null);
  const [leaving, setLeaving] = useState<{
    body: Body;
    back: boolean;
    /** Each page change its own layer, its slide from the start. */
    seq: number;
  } | null>(null);
  // The last open render's view, for either to leave from.
  const shown = useRef<{ key: string; body: Body } | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const current = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const leaveSeq = useRef(0);
  // The view's own height last measured, and the timer ending an ease.
  const height = useRef<{ natural: number | null; timer: number }>({
    natural: null,
    timer: 0,
  });

  // Follow the composer each frame while open: it can move without resizing
  // or scrolling (a panel opening beside the chat), and a frame's one
  // measurement replaces a stream of scroll events.
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      setBox((prev) =>
        !rect
          ? null
          : prev &&
            prev.left === rect.left &&
            prev.top === rect.top &&
            prev.width === rect.width
          ? prev
          : { left: rect.left, top: rect.top, width: rect.width }
      );
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [open, anchorRef]);

  // A new view slides in over the last one; a menu that shuts fades out.
  // Before `shown` takes this render (the effect after this one).
  useLayoutEffect(() => {
    const last = shown.current;
    if (open) {
      setClosing(null);
      if (!last || last.key === key || reduced) return;
      setLeaving({
        body: last.body,
        back: key === "root",
        seq: ++leaveSeq.current,
      });
      const timer = window.setTimeout(() => setLeaving(null), PAGE_MS);
      return () => window.clearTimeout(timer);
    }
    setLeaving(null);
    shown.current = null;
    if (!last || reduced) return;
    setClosing(last.body);
    const timer = window.setTimeout(() => setClosing(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, key, reduced]);
  useLayoutEffect(() => {
    if (open) shown.current = { key, body };
  });

  // The box eases to the view's own height when that changes (a new page,
  // rows filtered away), from where it is (mid-ease too), then follows its
  // content again. The view is measured by its rows, never as the box
  // squeezes it, and a render that changes nothing leaves an ease alone.
  useLayoutEffect(() => {
    const vp = viewport.current;
    const content = current.current;
    const h = height.current;
    if (!open || !vp || !content) {
      h.natural = null;
      return;
    }
    const natural = naturalHeight(content, vp);
    const last = h.natural;
    if (natural === last) return;
    h.natural = natural;
    if (reduced || last === null) return;
    const from = vp.style.height ? vp.getBoundingClientRect().height : last;
    vp.style.transition = "none";
    vp.style.height = `${from}px`;
    void vp.offsetHeight;
    vp.style.transition = `height ${HEIGHT_MS}ms cubic-bezier(.2,.8,.2,1)`;
    vp.style.height = `${natural}px`;
    window.clearTimeout(h.timer);
    h.timer = window.setTimeout(() => {
      vp.style.height = "";
      vp.style.transition = "";
    }, HEIGHT_MS + 20);
  });
  useEffect(() => {
    const h = height.current;
    return () => window.clearTimeout(h.timer);
  }, []);

  // The highlight bar glides to the active option; placed the first time
  // without a glide, and hidden while no option is active.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const option = activeId ? document.getElementById(activeId) : null;
    if (!option || !el.parentElement?.contains(option)) {
      el.style.opacity = "0";
      return;
    }
    const first = el.dataset.placed !== "true";
    if (first) el.style.transition = "none";
    el.style.opacity = "1";
    el.style.transform = `translateY(${option.offsetTop}px)`;
    el.style.height = `${option.offsetHeight}px`;
    if (first) {
      void el.offsetHeight;
      el.style.transition = "";
      el.dataset.placed = "true";
    }
  });

  useEffect(() => {
    if (!open || !activeId) return;
    const option = document.getElementById(activeId);
    // A section's first row brings the section's heading into view too:
    // with the list scrolled, wrapping to the top or stepping into Skills
    // from above would otherwise leave the heading out of sight.
    const before = option?.previousElementSibling;
    if (before?.getAttribute("role") === "presentation") {
      before.scrollIntoView?.({ block: "nearest" });
    }
    option?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);

  // Kept in the page, not in the menu, so it is announced as it changes
  // rather than mounted with the list.
  let status = "";
  if (open && view.kind === "page") {
    status = `${view.page.label}: ${
      view.rows.length === 0
        ? view.page.empty(view.filter)
        : plural(view.rows.length, "option", "options")
    }`;
  } else if (open && view.kind === "root") {
    const skillCount = view.marketplace
      ? "no skills installed"
      : skillsKnown
      ? plural(view.skills.length, "skill", "skills")
      : null;
    const commandCount =
      view.pages.length > 0
        ? plural(view.pages.length, "command", "commands")
        : null;
    status = commandCount
      ? skillCount
        ? `${commandCount}, ${skillCount}`
        : commandCount
      : view.marketplace
      ? "No skills installed"
      : skillCount ?? "";
  }
  // Keep the composer's focus: a mousedown here would take it.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const shownBody = open ? body : closing;

  return (
    <>
      <span
        role="status"
        className="sr-only"
      >
        {status}
      </span>
      {shownBody &&
        box &&
        createPortal(
          <div
            data-slot="slash-menu"
            data-state={open ? "open" : "closed"}
            aria-hidden={open ? undefined : true}
            inert={!open}
            className={cn(
              "fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg",
              open
                ? "duration-150 animate-in fade-in-0 slide-in-from-bottom-1"
                : "pointer-events-none animate-out fade-out-0 slide-out-to-bottom-1 fill-mode-forwards [animation-duration:110ms]"
            )}
            style={{
              left: box.left,
              width: box.width,
              bottom: window.innerHeight - box.top + GAP,
              // Opening upward, the room above the composer is all there is:
              // the list gives way, the header, hint row and borders don't.
              maxHeight: Math.max(0, box.top - GAP - EDGE),
            }}
            onMouseDown={keepFocus}
          >
            <div
              ref={viewport}
              className="relative flex min-h-0 flex-col overflow-hidden"
            >
              {open && leaving && (
                <div
                  key={leaving.seq}
                  data-slot="slash-page"
                  data-leaving=""
                  aria-hidden="true"
                  inert
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 flex flex-col duration-200 animate-out fade-out-0 fill-mode-forwards",
                    leaving.back
                      ? "slide-out-to-right-6"
                      : "slide-out-to-left-6"
                  )}
                >
                  <MenuBody
                    body={leaving.body}
                    live={false}
                  />
                </div>
              )}
              <div
                ref={current}
                key={open ? key : "closing"}
                data-slot="slash-page"
                className={cn(
                  "flex min-h-0 flex-col",
                  open &&
                    leaving &&
                    cn(
                      "duration-200 animate-in fade-in-0",
                      leaving.back
                        ? "slide-in-from-left-6"
                        : "slide-in-from-right-6"
                    )
                )}
              >
                <MenuBody
                  body={shownBody}
                  live={open}
                  barRef={bar}
                />
              </div>
            </div>
            <p
              aria-hidden="true"
              className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground"
            >
              {hintFor(shownBody)}
            </p>
          </div>,
          document.body
        )}
    </>
  );
}
