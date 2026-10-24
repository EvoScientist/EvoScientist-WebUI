"use client";

import React, { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Puzzle,
  Sparkles,
  SquareSlash,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { MenuSkill } from "@/app/hooks/useSlashMenu";
import type { MenuCommand } from "@/lib/slashMenu";
import { cn } from "@/lib/utils";

// A command's icon is its pill's (the goal's target, the model's sparkles).
const COMMAND_ICONS: Record<string, LucideIcon> = {
  goal: Target,
  model: Sparkles,
};
const ROW = "mb-0 flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm";
const ICON = "size-3.5 shrink-0 text-muted-foreground";
const HEADING =
  "mb-0 select-none px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground";

// Gap to the composer, and the margin kept from the window's top edge.
const GAP = 6;
const EDGE = 8;

interface SlashSkillMenuProps {
  open: boolean;
  /** The composer box the menu sits above, at its width. */
  anchorRef: React.RefObject<HTMLElement | null>;
  listboxId: string;
  /** An option's id, by skill name (null: the marketplace option). */
  optionId: (name: string | null) => string;
  /** A command row's id, by its index. */
  commandId?: (index: number) => string;
  /** Rows above the skills; `active` counts them first. */
  commands?: readonly MenuCommand[];
  /** The active option's id, as the textarea's aria-activedescendant. */
  activeId?: string;
  items: MenuSkill[];
  active: number;
  /** No skill installed and a bare `/`: the way to the marketplace, as the
   *  last row after any commands. */
  marketplace: boolean;
  /** Whether the skills were read: until then, and after a failed read, the
   *  status counts none rather than saying 0. */
  skillsKnown: boolean;
  /** Whether Enter runs the highlighted row: a command the composer can run
   *  (otherwise Enter inserts it). */
  enterRuns: boolean;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  onBrowse?: () => void;
}

/**
 * The `/` menu's list (state in `useSlashMenu`). It renders into the body,
 * because the composer clips what overflows it; focus stays in the textarea,
 * which points at the active option with `aria-activedescendant`.
 */
export function SlashSkillMenu({
  open,
  anchorRef,
  listboxId,
  optionId,
  commandId = () => "",
  commands = [],
  activeId,
  items,
  active,
  marketplace,
  skillsKnown,
  enterRuns,
  onPick,
  onHover,
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

  // Kept in the page, not in the menu, so the count is announced as it
  // changes rather than mounted with the list.
  const skillCount = marketplace
    ? "no skills installed"
    : skillsKnown
    ? `${items.length} ${items.length === 1 ? "skill" : "skills"}`
    : null;
  const commandCount =
    commands.length > 0
      ? `${commands.length} ${commands.length === 1 ? "command" : "commands"}`
      : null;
  const status = !open
    ? ""
    : commandCount
    ? skillCount
      ? `${commandCount}, ${skillCount}`
      : commandCount
    : marketplace
    ? "No skills installed"
    : skillCount ?? "";
  // The marketplace row's place in the one index.
  const marketplaceIndex = commands.length + items.length;
  // What Enter does on the highlighted row.
  const hint =
    marketplace && active === marketplaceIndex
      ? "↑ ↓ to choose · Enter to open · Esc to close"
      : enterRuns
      ? "↑ ↓ to choose · Enter to run · Tab to insert · Esc to close"
      : "↑ ↓ to choose · Enter or Tab to insert · Esc to close";
  // Keep the composer's focus: a mousedown here would take it.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
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
              // the list gives way, the hint row and borders don't.
              maxHeight: Math.max(0, box.top - GAP - EDGE),
            }}
            onMouseDown={keepFocus}
          >
            {/* Commands and skills each under a heading, a rule between
                them (the APG's grouped listbox: the headings are not
                options, so the keys skip them). */}
            <div
              id={listboxId}
              role="listbox"
              aria-label={
                commands.length === 0
                  ? "Skills"
                  : items.length > 0 || marketplace
                  ? "Commands and skills"
                  : "Commands"
              }
              className="m-0 max-h-96 min-h-0 overflow-y-auto px-0 py-1"
            >
              {commands.length > 0 && (
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
                  {commands.map((command, index) => {
                    const Icon = COMMAND_ICONS[command.word] ?? SquareSlash;
                    return (
                      <li
                        key={command.label}
                        id={commandId(index)}
                        role="option"
                        aria-selected={index === active}
                        onMouseEnter={() => onHover(index)}
                        onClick={() => onPick(index)}
                        className={cn(ROW, index === active && "bg-accent")}
                      >
                        <Icon
                          className={ICON}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 truncate font-mono text-foreground">
                          /{command.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {command.description}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {(items.length > 0 || marketplace) && (
                <ul
                  role="group"
                  aria-labelledby={`${listboxId}-skills`}
                  className={cn(
                    "m-0 list-none p-0",
                    commands.length > 0 &&
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
                  {items.map((skill, skillIndex) => {
                    // One index over the commands, then the skills.
                    const index = commands.length + skillIndex;
                    return (
                      <li
                        key={skill.name}
                        id={optionId(skill.name)}
                        role="option"
                        aria-selected={index === active}
                        onMouseEnter={() => onHover(index)}
                        onClick={() => onPick(index)}
                        className={cn(ROW, index === active && "bg-accent")}
                      >
                        <Puzzle
                          className={ICON}
                          aria-hidden="true"
                        />
                        {/* A name too long for the row truncates; the source
                            keeps its place. */}
                        <span className="min-w-0 truncate font-mono text-foreground">
                          /{skill.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {skill.description}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {skill.source === "workspace"
                            ? "Workspace"
                            : "Global"}
                        </span>
                      </li>
                    );
                  })}
                  {marketplace && (
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
