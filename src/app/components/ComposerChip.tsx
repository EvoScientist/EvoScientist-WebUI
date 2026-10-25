"use client";

import React, { useLayoutEffect, useRef } from "react";
import { Pencil, Puzzle, Target, X, type LucideIcon } from "lucide-react";
import type { ComposerChip as Chip } from "@/lib/composerChip";
import { canAnimate, prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

// How long a chip flies in from the menu and collapses when it leaves.
const FLY_MS = 260;
const LEAVE_MS = 140;
const EASE = "cubic-bezier(.2,.8,.2,1)";

const LOOK: Record<
  Chip["kind"],
  { icon: LucideIcon; label: (chip: Chip) => string; remove: string }
> = {
  skill: {
    icon: Puzzle,
    label: (chip) => (chip.kind === "skill" ? chip.name : ""),
    remove: "Remove /",
  },
  goal: { icon: Target, label: () => "Goal", remove: "Leave goal mode" },
  amend: {
    icon: Pencil,
    label: () => "Amend goal",
    remove: "Leave amend mode",
  },
};

/** Whether this page can run Web Animations and the user wants motion. */
const motionOn = () =>
  typeof document !== "undefined" &&
  canAnimate(document.body) &&
  !prefersReducedMotion();

/**
 * A chip at the start of the composer: the skill the message's first word
 * pins (soft), or the goal mode the `/` menu put the box in (solid). It
 * stands for the start of the composer's one string; with `onRemove` it has
 * a remove button, without it is a static chip (sent and queued messages).
 * `flyFrom` is where the menu row it was picked from sat: the chip flies in
 * from there (a ghost in the page, since the composer clips), else it pops;
 * only the value at its mount counts, so a chip that comes back later
 * doesn't fly again. A `leaving` chip folds to nothing (width, padding,
 * border and its gap), then calls `onLeft`. `disabled` disables its remove
 * button (the composer can't be used).
 */
export function ComposerChip({
  chip,
  onRemove,
  flyFrom,
  leaving = false,
  onLeft,
  disabled = false,
  className,
}: {
  chip: Chip;
  onRemove?: () => void;
  flyFrom?: DOMRect | null;
  leaving?: boolean;
  onLeft?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const look = LOOK[chip.kind];
  const label = look.label(chip);
  const flyFromAtMount = useRef(flyFrom ?? null);
  const flies = !!flyFromAtMount.current && !leaving && motionOn();
  const leftRef = useRef(onLeft);
  useLayoutEffect(() => {
    leftRef.current = onLeft;
  });

  // In from the menu row: a ghost flies over the page to where the chip is,
  // which waits hidden until it lands.
  useLayoutEffect(() => {
    const flyFrom = flyFromAtMount.current;
    const el = ref.current;
    if (!flyFrom || leaving || !el || !canAnimate(el) || !motionOn()) return;
    const to = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-slot");
    ghost.setAttribute("data-ghost", "composer-chip");
    ghost.setAttribute("aria-hidden", "true");
    // A copy, remove button and all: out of reach.
    ghost.setAttribute("inert", "");
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${to.left}px`,
      top: `${to.top}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
      margin: "0",
      zIndex: "60",
      pointerEvents: "none",
      visibility: "visible",
    });
    document.body.appendChild(ghost);
    el.style.visibility = "hidden";
    const dx = Math.round(flyFrom.left - to.left);
    const dy = Math.round(
      flyFrom.top + flyFrom.height / 2 - (to.top + to.height / 2)
    );
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      ghost.remove();
      el.style.visibility = "";
    };
    const animation = ghost.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.94)`, opacity: 0 },
        { opacity: 1, offset: 0.3 },
        { transform: "none", opacity: 1 },
      ],
      { duration: FLY_MS, easing: EASE }
    );
    animation.onfinish = land;
    return land;
  }, [leaving]);

  // Out: the chip folds to nothing, padding, border and the gap after it
  // included (border-box would keep it 14 px wide), so the text after it
  // slides to where it stays. Unmounted meanwhile (another chip left), the
  // fold stops and doesn't say it has left.
  useLayoutEffect(() => {
    if (!leaving) return;
    const el = ref.current;
    if (!el || !canAnimate(el) || !motionOn()) {
      leftRef.current?.();
      return;
    }
    const width = el.getBoundingClientRect().width;
    const style = getComputedStyle(el);
    const animation = el.animate(
      [
        {
          width: `${width}px`,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          borderLeftWidth: style.borderLeftWidth,
          borderRightWidth: style.borderRightWidth,
          marginRight: style.marginRight,
          opacity: 1,
          transform: "scale(1)",
        },
        {
          width: "0px",
          paddingLeft: "0px",
          paddingRight: "0px",
          borderLeftWidth: "0px",
          borderRightWidth: "0px",
          marginRight: "0px",
          opacity: 0,
          transform: "scale(0.85)",
        },
      ],
      { duration: LEAVE_MS, easing: "ease-in", fill: "forwards" }
    );
    animation.onfinish = () => leftRef.current?.();
    return () => {
      animation.onfinish = null;
      animation.cancel();
    };
  }, [leaving]);

  const Icon = look.icon;
  return (
    <span
      ref={ref}
      data-slot={leaving ? "composer-chip-leaving" : "composer-chip"}
      data-kind={chip.kind}
      aria-hidden={leaving ? true : undefined}
      title={chip.kind === "skill" ? `/${label}` : undefined}
      className={cn(
        "inline-flex h-6 max-w-[min(16rem,50%)] shrink-0 items-center gap-1 rounded-md border border-solid pl-1.5 text-xs font-medium",
        // Only a folding chip clips: the remove button's touch area reaches
        // out of it (the name truncates by itself).
        leaving && "overflow-hidden",
        chip.kind === "skill"
          ? "border-[color-mix(in_srgb,var(--brand)_28%,transparent)] bg-[var(--brand-soft)] text-[var(--brand)]"
          : "border-transparent bg-[var(--brand-solid)] text-[var(--brand-foreground)]",
        // A folding chip came from the composer: it keeps the remove
        // button's room, so the fold starts at its own width.
        onRemove || leaving ? "pr-0.5" : "pr-1.5",
        // Only the composer's chip pops: a sent or queued message's is there
        // with its message.
        onRemove &&
          !flies &&
          !leaving &&
          "duration-150 animate-in fade-in-0 zoom-in-90",
        className
      )}
    >
      <Icon
        className="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{label}</span>
      {leaving && (
        <span
          data-slot="remove-room"
          className="inline-flex size-4 shrink-0 items-center justify-center opacity-60"
        >
          <X
            className="size-3"
            aria-hidden="true"
          />
        </span>
      )}
      {onRemove && !leaving && (
        <button
          type="button"
          aria-label={
            chip.kind === "skill" ? `${look.remove}${label}` : look.remove
          }
          // Keep the composer's focus.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
          disabled={disabled}
          className="composer-chip-remove relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm opacity-60 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <X
            className="size-3"
            aria-hidden="true"
          />
        </button>
      )}
    </span>
  );
}
