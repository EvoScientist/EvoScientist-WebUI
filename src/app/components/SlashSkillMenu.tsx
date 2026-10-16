"use client";

import React, { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { MenuSkill } from "@/app/hooks/useSlashMenu";
import { cn } from "@/lib/utils";

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
  items: MenuSkill[];
  active: number;
  /** No skill installed: show the way to the marketplace instead. */
  empty: boolean;
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
  items,
  active,
  empty,
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

  const activeName = items[active]?.name;
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(optionId(empty ? null : activeName ?? null))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, empty, activeName, optionId]);

  // Kept in the page, not in the menu, so the count is announced as it
  // changes rather than mounted with the list.
  const status = !open
    ? ""
    : empty
    ? "No skills installed"
    : `${items.length} ${items.length === 1 ? "skill" : "skills"}`;
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
            <ul
              id={listboxId}
              role="listbox"
              aria-label="Skills"
              className="m-0 max-h-72 min-h-0 list-none overflow-y-auto px-0 py-1"
            >
              {empty ? (
                <li
                  id={optionId(null)}
                  role="option"
                  aria-selected
                  onClick={onBrowse}
                  className="cursor-pointer bg-accent px-3 py-2 text-sm text-muted-foreground"
                >
                  No skills installed. Browse the Skills marketplace
                </li>
              ) : (
                items.map((skill, index) => (
                  <li
                    key={skill.name}
                    id={optionId(skill.name)}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => onHover(index)}
                    onClick={() => onPick(index)}
                    className={cn(
                      "flex cursor-pointer items-baseline gap-3 px-3 py-1.5 text-sm",
                      index === active && "bg-accent"
                    )}
                  >
                    <span className="shrink-0 font-mono text-foreground">
                      /{skill.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {skill.description}
                    </span>
                    {skill.source === "workspace" && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        workspace
                      </span>
                    )}
                  </li>
                ))
              )}
            </ul>
            <p
              aria-hidden="true"
              className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground"
            >
              ↑ ↓ to choose · Enter or Tab to insert · Esc to close
            </p>
          </div>,
          document.body
        )}
    </>
  );
}
