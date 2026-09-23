"use client";

// What the orchestrator can dispatch right now, next to the model pill.
//
// There is deliberately nothing to switch on here. An installed expert is
// already in the dispatch tables — the backend's `active_teams` was only ever
// a prompt-level preference, never a gate — so this is a read-only pointer:
// it answers "who could take this task" without pulling you out of the chat.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Users } from "lucide-react";

import type { TeamEntry } from "@/lib/teams";

const PANEL_WIDTH = 288; // w-72
const GAP = 6;
const EDGE = 8;

export function ExpertsPill({
  teams,
  onManage,
}: {
  teams: TeamEntry[];
  /** Jump to the full Experts view. */
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The composer clips its children (rounded corners, `overflow-hidden`), and
  // this panel opens upward — rendered in place it is cut off entirely. So it
  // goes to the body with a fixed position measured off the trigger.
  const [pos, setPos] = useState<{
    left: number;
    bottom: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxLeft = window.innerWidth - PANEL_WIDTH - EDGE;
    setPos({
      left: Math.max(EDGE, Math.min(rect.left, maxLeft)),
      bottom: window.innerHeight - rect.top + GAP,
      // Opening upward from a bottom-pinned composer, the room above the
      // trigger is all there is. Without this the header and first entries
      // end up off-screen on a short window.
      maxHeight: Math.max(0, rect.top - GAP - EDGE),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // Re-measure rather than drift: the trigger moves with the composer as
    // the window resizes. Scroll is listened to in the capture phase so a
    // nested container counts too, and coalesced to one frame — `place`
    // reads layout, and an unthrottled scroll would do that per event.
    let frame = 0;
    const remeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [open, place]);

  if (teams.length === 0) return null;

  const label = `${teams.length} expert${teams.length === 1 ? "" : "s"}`;

  const panel = (
    <div
      ref={panelRef}
      style={
        pos
          ? {
              left: pos.left,
              bottom: pos.bottom,
              width: PANEL_WIDTH,
              maxHeight: pos.maxHeight,
            }
          : undefined
      }
      className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <p className="shrink-0 border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
        Available experts
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {teams.map((team) => (
          <li
            key={team.name}
            className="border-b border-border/60 px-3 py-2 last:border-b-0"
          >
            <p className="text-xs font-medium text-foreground">{team.name}</p>
            {team.description && (
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                {team.description}
              </p>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onManage();
        }}
        className="w-full shrink-0 border-t border-border px-3 py-2 text-left text-[11px] font-medium text-[var(--brand)] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        Manage in Experts →
      </button>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) place();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--brand)] bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--brand)] transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
        title="Experts the orchestrator can dispatch on this deployment"
      >
        <Users
          className="size-3"
          aria-hidden="true"
        />
        {label}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(panel, document.body)
        : null}
    </>
  );
}
