"use client";

import { forwardRef } from "react";
import type { ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared shape for one row of the left-rail primary navigation. Extracted
 *  from the ad-hoc buttons that used to duplicate the same Tailwind blob in
 *  `ThreadList.tsx`. Styling (border-b separator, hover accent, active
 *  bg-accent, size-4 icon, gap-2.5) matches the previous inline entries. */
interface RailNavItemProps {
  /** lucide-react icon component (e.g. `SquarePen`). */
  icon: LucideIcon;
  label: string;
  /** Applies the `bg-accent` overlay used to indicate "this view is showing". */
  active: boolean;
  onClick: () => void;
  /** Numeric badge (used by EvoMemory's unseen counter) or a fully-custom
   *  ReactNode. Left-aligned via `ml-auto`. */
  badge?: number | ReactNode;
  /** When present, renders a chevron next to the label. `expanded` rotates it
   *  180deg so it points up — matches the "More" drawer state. */
  chevron?: "collapsed" | "expanded";
  "aria-label"?: string;
  "aria-expanded"?: boolean;
}

export const RailNavItem = forwardRef<HTMLButtonElement, RailNavItemProps>(
  function RailNavItem(
    {
      icon: Icon,
      label,
      active,
      onClick,
      badge,
      chevron,
      "aria-label": ariaLabel,
      "aria-expanded": ariaExpanded,
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={ariaLabel ?? label}
        aria-expanded={ariaExpanded}
        className={cn(
          "flex flex-shrink-0 items-center gap-2.5 border-b border-border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active && "bg-accent"
        )}
      >
        <Icon
          className="size-4"
          aria-hidden="true"
        />
        <span>{label}</span>
        {badge !== undefined && badge !== null && badge !== 0 && (
          <span className="ml-auto inline-flex items-center">
            {typeof badge === "number" ? (
              <span
                className="inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--brand-solid)] px-1 text-[10px] font-bold leading-none text-[var(--brand-foreground)]"
                aria-label={`${badge} update${badge === 1 ? "" : "s"}`}
              >
                {badge}
              </span>
            ) : (
              badge
            )}
          </span>
        )}
        {chevron && (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              badge === undefined && "ml-auto",
              chevron === "expanded" && "rotate-180"
            )}
          />
        )}
      </button>
    );
  }
);
