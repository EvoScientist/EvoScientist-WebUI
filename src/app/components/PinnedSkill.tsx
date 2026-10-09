"use client";

import React, { useState } from "react";
import { ChevronRight, Puzzle } from "lucide-react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { pinnedSkillBody } from "@/lib/pinnedSkill";
import { cn } from "@/lib/utils";

// Headings in a SKILL.md read at body size, bold, like the rest of the panel.
// Same variants as MarkdownContent's own heading rules so tailwind-merge drops
// its font-semibold in favour of font-bold.
const PANEL_HEADINGS =
  "[&_h1]:text-sm [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_h3]:text-sm [&_h3]:font-bold";

interface PinnedSkillProps {
  name: string;
  /** One-line skill description, if the backend sent one. */
  description?: string | null;
  /** Raw pinned message content (`<skill …>` wrapper + SKILL.md body). */
  content: string;
}

/**
 * A skill the user named with `/skill-name`, shown as a collapsed row that
 * mirrors the "Thinking" disclosure in ChatMessage. Open, it shows the
 * description and the SKILL.md the agent was handed.
 */
export const PinnedSkill = React.memo<PinnedSkillProps>(
  ({ name, description, content }) => {
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
          <Puzzle
            className="h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 break-words text-left">{`Skill · ${name}`}</span>
        </button>
        {open && (
          <div className="mt-2 border-l-2 border-border pl-3 text-sm text-muted-foreground">
            {description && (
              <p className="mb-3 break-words leading-relaxed">{description}</p>
            )}
            <MarkdownContent
              content={pinnedSkillBody(content)}
              className={PANEL_HEADINGS}
            />
          </div>
        )}
      </div>
    );
  }
);

PinnedSkill.displayName = "PinnedSkill";
