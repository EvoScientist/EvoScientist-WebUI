"use client";

import React, { useEffect, useLayoutEffect, useState } from "react";
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
const LISTBOX = "m-0 max-h-96 min-h-0 overflow-y-auto px-0 py-1";

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

/**
 * The `/` menu (state in `useSlashMenu`): the commands' pages and the skills,
 * or one page's rows. It renders into the body, because the composer clips
 * what overflows it; focus stays in the textarea, which points at the active
 * option with `aria-activedescendant`.
 */
export function SlashSkillMenu({
  open,
  anchorRef,
  listboxId,
  optionId,
  pageId,
  rowId,
  activeId,
  active,
  view,
  skillsKnown,
  onChoose,
  onHover,
  onBack,
  onBrowse,
}: SlashSkillMenuProps) {
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

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
  // What Enter does on the highlighted row.
  const marketplaceIndex =
    view.kind === "root" ? view.pages.length + view.skills.length : -1;
  const hint =
    view.kind === "page"
      ? "↑ ↓ to choose · Enter to select · Type to filter · ← to go back"
      : (view.marketplace && active === marketplaceIndex) ||
        active < view.pages.length
      ? "↑ ↓ to choose · Enter to open · Esc to close"
      : "↑ ↓ to choose · Enter or Tab to add · Esc to close";
  // Keep the composer's focus: a mousedown here would take it.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const rootList = view.kind === "root" && (
    // Commands and skills each under a heading, a rule between them (the
    // APG's grouped listbox: the headings are not options, so the keys skip
    // them).
    <div
      id={listboxId}
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
      {view.pages.length > 0 && (
        <ul
          role="group"
          aria-labelledby={`${listboxId}-commands`}
          className="m-0 list-none p-0"
        >
          <li
            role="presentation"
            id={`${listboxId}-commands`}
            className={HEADING}
          >
            Commands
          </li>
          {view.pages.map((page, index) => {
            const Icon = ICONS[page.icon];
            return (
              <li
                key={page.word}
                id={pageId(page.word)}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => onHover(index)}
                onClick={() => onChoose(index)}
                className={cn(ROW, index === active && "bg-accent")}
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
          aria-labelledby={`${listboxId}-skills`}
          className={cn(
            "m-0 list-none p-0",
            view.pages.length > 0 &&
              "mt-1 border-0 border-t border-solid border-border pt-1"
          )}
        >
          <li
            role="presentation"
            id={`${listboxId}-skills`}
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
                id={optionId(skill.name)}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => onHover(index)}
                onClick={() => onChoose(index)}
                className={cn(ROW, index === active && "bg-accent")}
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
              id={optionId(null)}
              role="option"
              aria-selected={marketplaceIndex === active}
              onMouseEnter={() => onHover(marketplaceIndex)}
              onClick={onBrowse}
              className={cn(
                ROW,
                "py-2 text-muted-foreground",
                marketplaceIndex === active && "bg-accent"
              )}
            >
              <Puzzle
                className={ICON}
                aria-hidden="true"
              />
              No skills installed. Browse the Skills marketplace
            </li>
          )}
        </ul>
      )}
    </div>
  );

  const pageList = view.kind === "page" && (
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
        id={listboxId}
        role="listbox"
        aria-label={view.page.label}
        className={LISTBOX}
      >
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
                  id={rowId(row.id)}
                  role="option"
                  aria-selected={index === active}
                  data-tone={row.danger ? "danger" : undefined}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onChoose(index)}
                  className={cn(ROW, index === active && "bg-accent")}
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

  return (
    <>
      <span
        role="status"
        className="sr-only"
      >
        {status}
      </span>
      {open &&
        box &&
        createPortal(
          <div
            className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
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
            {rootList}
            {pageList}
            <p
              aria-hidden="true"
              className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground"
            >
              {hint}
            </p>
          </div>,
          document.body
        )}
    </>
  );
}
