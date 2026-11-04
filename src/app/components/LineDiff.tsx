"use client";

import { useState, useRef, useMemo, useCallback, useId } from "react";
import { cn } from "@/lib/utils";
import {
  clipLine,
  foldRows,
  type DiffRow,
  type FileEditDiff,
  type ShownRow,
} from "@/lib/fileEditDiff";

function countLines(n: number, what: string): string {
  return `${n} ${n === 1 ? "line" : "lines"} ${what}`;
}

// "+2 −1" next to a file edit's name; read out as words.
export function DiffCounts({
  added,
  removed,
  perMatch,
}: {
  added: number;
  removed: number;
  perMatch: boolean;
}) {
  const spoken = [
    added > 0 && countLines(added, "added"),
    removed > 0 && countLines(removed, "removed"),
  ].filter(Boolean);
  return (
    <span className="font-mono text-xs">
      <span
        aria-hidden="true"
        className="flex gap-1.5"
      >
        {added > 0 && (
          <span className="text-[var(--color-diff-added)]">+{added}</span>
        )}
        {removed > 0 && (
          <span className="text-[var(--color-diff-removed)]">−{removed}</span>
        )}
        {perMatch && (
          <span className="font-sans text-muted-foreground">per match</span>
        )}
      </span>
      <span className="sr-only">
        {spoken.join(", ") + (perMatch ? " per match" : "")}
      </span>
    </span>
  );
}

const SIGNS = { added: "+", removed: "−", context: " " } as const;
const SPOKEN = { added: "Added: ", removed: "Removed: " } as const;

function DiffLine({
  row,
  whole,
  onShowWhole,
}: {
  row: DiffRow;
  whole: boolean;
  onShowWhole: () => void;
}) {
  if (row.kind === "gap") {
    return (
      <li className="mb-0 select-none px-2 text-muted-foreground">
        <span aria-hidden="true">⋯</span>
        <span className="sr-only">Unchanged lines skipped</span>
      </li>
    );
  }
  if (row.kind === "note") {
    return (
      <li className="mb-0 select-none px-2 font-sans italic text-muted-foreground">
        {row.text}
      </li>
    );
  }
  const clipped = whole ? null : clipLine(row.text);
  return (
    <li
      className={cn(
        "mb-0 flex whitespace-pre-wrap px-2",
        row.kind === "added" && "bg-[var(--color-diff-added-bg)]",
        row.kind === "removed" && "bg-[var(--color-diff-removed-bg)]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-4 shrink-0 select-none",
          row.kind === "added" && "text-[var(--color-diff-added)]",
          row.kind === "removed" && "text-[var(--color-diff-removed)]"
        )}
      >
        {SIGNS[row.kind]}
      </span>
      <span className="min-w-0 flex-1 break-words">
        {row.kind !== "context" && (
          <span className="sr-only select-none">{SPOKEN[row.kind]}</span>
        )}
        {clipped ? clipped.head : row.text}
        {clipped && (
          <button
            type="button"
            onClick={onShowWhole}
            className="block select-none font-sans text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
          >
            Show {clipped.more.toLocaleString("en-US")} more characters
          </button>
        )}
      </span>
    </li>
  );
}

function FoldLine({
  hidden,
  onShowAll,
}: {
  hidden: number;
  onShowAll: () => void;
}) {
  return (
    <li className="mb-0 select-none">
      <button
        type="button"
        onClick={onShowAll}
        className="w-full px-2 py-0.5 pl-6 text-left font-sans text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:min-h-11"
      >
        Show {hidden} more {hidden === 1 ? "line" : "lines"}
      </button>
    </li>
  );
}

export function LineDiff({
  diff,
  heading,
  compact = false,
}: {
  diff: FileEditDiff;
  heading: string;
  compact?: boolean;
}) {
  // What the reader opened, for this diff only: the same call shown with
  // other args (a sub-agent's restored steps replaced by live ones) starts
  // folded again.
  const [opened, setOpened] = useState<{
    diff: FileEditDiff;
    all: boolean;
    lines: ReadonlySet<number>;
  } | null>(null);
  const openedHere = opened && opened.diff === diff ? opened : null;
  const diffListRef = useRef<HTMLUListElement>(null);
  const diffHeadingId = useId();
  const reveal = useCallback(
    (change: { all: true } | { line: number }) => {
      if (!diff) return;
      setOpened((prev) => {
        const here = prev?.diff === diff ? prev : null;
        const lines = new Set(here?.lines);
        if ("line" in change) lines.add(change.line);
        return { diff, all: "all" in change || !!here?.all, lines };
      });
      // The "Show more" button goes away; keep focus in the diff.
      diffListRef.current?.focus({ preventScroll: true });
    },
    [diff]
  );
  // Built once per change, not on each streamed token.
  const diffItems = useMemo(() => {
    if (!diff) return null;
    const shown: ShownRow[] = openedHere?.all
      ? diff.rows.map((row, key) => ({ key, row }))
      : foldRows(diff.rows);
    return shown.map((item) =>
      item.key === "fold" ? (
        <FoldLine
          key="fold"
          hidden={item.hidden}
          onShowAll={() => reveal({ all: true })}
        />
      ) : (
        <DiffLine
          key={item.key}
          row={item.row}
          whole={!!openedHere?.lines.has(item.key)}
          onShowWhole={() => reveal({ line: item.key })}
        />
      )
    );
  }, [diff, openedHere, reveal]);
  return (
    <div className={cn("mt-4", compact && "mt-2")}>
      <h4
        id={diffHeadingId}
        className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {heading}
      </h4>
      {/* role: Safari drops the list role of a list without
          bullets, and with it the name. */}
      <ul
        ref={diffListRef}
        role="list"
        tabIndex={-1}
        aria-labelledby={diffHeadingId}
        className={cn(
          "m-0 overflow-hidden rounded-sm border border-border bg-[var(--color-surface)] px-0 py-1 font-mono text-xs leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          compact && "py-0.5 text-[11px] leading-5"
        )}
      >
        {diffItems}
      </ul>
    </div>
  );
}
