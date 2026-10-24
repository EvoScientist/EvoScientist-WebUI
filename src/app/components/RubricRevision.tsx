"use client";

import React, { useState } from "react";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { RUBRIC_REVISION_LABEL } from "@/lib/rubricRevision";
import { cn } from "@/lib/utils";

interface RubricRevisionProps {
  /** The grader's feedback, as the message carries it. */
  content: string;
}

/**
 * The rubric grader's request for revisions, shown as a collapsed row like a
 * pinned skill: the backend sent it to the agent, the user did not type it.
 */
export const RubricRevision = React.memo<RubricRevisionProps>(({ content }) => {
  const [open, setOpen] = useState(false);

  return (
    <div
      data-open={open ? "" : undefined}
      className="mt-4 min-w-0 max-w-full [&+&]:mt-1 [&[data-open]+&]:mt-2"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex max-w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-90"
          )}
          aria-hidden="true"
        />
        <ClipboardCheck
          className="h-3.5 w-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="min-w-0 break-words text-left">
          {RUBRIC_REVISION_LABEL}
        </span>
      </button>
      {open && (
        <div className="mt-2 border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </p>
        </div>
      )}
    </div>
  );
});

RubricRevision.displayName = "RubricRevision";
