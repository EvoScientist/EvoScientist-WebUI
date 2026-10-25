"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Target } from "lucide-react";

import type { GoalBusy } from "@/app/hooks/useChat";
import { RUBRIC_RESULT_TEXT } from "@/lib/goalEvents";
import type { GoalStatus, RubricVerdict, ThreadGoal } from "@/lib/goalState";
import { SwapText } from "@/app/components/SwapText";

const PANEL_WIDTH = 320; // w-80
const GAP = 6;
const EDGE = 8;

// The TUI's status bar ("goal: done" for a complete goal).
const STATUS_WORDS: Record<GoalStatus, string> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  complete: "done",
};
// /goal show's note labels (_NOTE_LABELS); any other status says "Note".
const NOTE_LABELS: Partial<Record<GoalStatus, string>> = {
  blocked: "Blocked",
  complete: "Result",
};

/**
 * The open thread's goal next to the model pill. Opening it shows what
 * /goal show prints and the latest grading; `/goal` (show) opens it too, so
 * its owner holds `open`. While the goal is drafted or graded it says so.
 */
export function GoalPill({
  goal,
  busy,
  verdict,
  open,
  onOpenChange,
}: {
  goal: ThreadGoal | null;
  busy: GoalBusy;
  verdict: RubricVerdict | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pos, setPos] = useState<{
    left: number;
    bottom: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const shown = open && !!goal;

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // A window narrower than the panel gets a narrower panel.
    const width = Math.max(
      0,
      Math.min(PANEL_WIDTH, window.innerWidth - 2 * EDGE)
    );
    const maxLeft = window.innerWidth - width - EDGE;
    setPos({
      left: Math.max(EDGE, Math.min(rect.left, maxLeft)),
      bottom: window.innerHeight - rect.top + GAP,
      width,
      maxHeight: Math.max(0, rect.top - GAP - EDGE),
    });
  }, []);

  useEffect(() => {
    if (!shown) return;
    place();
    const onDocDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
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
  }, [shown, place, onOpenChange]);

  // Without a goal only its drafting shows: a rubric set without one (the
  // TUI's /rubric) is graded too, and its results are toasts only.
  if (!goal && busy !== "drafting") return null;

  const label =
    busy === "drafting"
      ? "Drafting criteria…"
      : busy === "checking"
      ? "Checking…"
      : `goal: ${STATUS_WORDS[goal!.status]}`;
  const note = goal?.note?.trim();

  const panel = goal && (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Goal"
      style={
        pos
          ? {
              left: pos.left,
              bottom: pos.bottom,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }
          : undefined
      }
      className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
        Goal ({goal.status})
      </p>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 text-[11px] leading-relaxed">
        <p className="whitespace-pre-wrap break-words text-xs text-foreground">
          {goal.objective}
        </p>
        {note && (
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {NOTE_LABELS[goal.status] ?? "Note"}: {note}
          </p>
        )}
        <p className="font-semibold text-foreground">Acceptance criteria:</p>
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {goal.criteria}
        </p>
        {verdict && (
          <p className="whitespace-pre-wrap break-words border-t border-border/60 pt-2 text-muted-foreground">
            <span className="font-medium text-foreground">
              {RUBRIC_RESULT_TEXT[verdict.result]}
            </span>
            {verdict.explanation ? `: ${verdict.explanation}` : ""}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={!goal}
        onClick={() => onOpenChange(!open)}
        aria-expanded={shown}
        className="inline-flex items-center gap-1.5 rounded-full border border-solid border-[var(--brand)] bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--brand)] transition-colors focus-visible:ring-2 focus-visible:ring-ring enabled:hover:border-[var(--brand-hover)] enabled:hover:text-[var(--brand-hover)] disabled:cursor-default"
        title="This chat's goal and its acceptance criteria"
      >
        <Target
          className="size-3"
          aria-hidden="true"
        />
        <SwapText text={label} />
      </button>
      {shown && typeof document !== "undefined"
        ? createPortal(panel, document.body)
        : null}
    </>
  );
}
