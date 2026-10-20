"use client";

import { useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import { PANEL_HEADINGS } from "@/app/components/PinnedSkill";
import type { Reasoning } from "@/lib/reasoning";
import { cn } from "@/lib/utils";

/** A message's reasoning as a collapsed row that opens to the text. Shared by
 *  the chat and the sub-agent steps. */
export function ThinkingRow({
  reasoning,
  thinking,
  label,
  isStreaming,
  compact = false,
  markdownClassName,
  className,
}: {
  reasoning: Reasoning;
  /** Still thinking: the row says "Thinking…" instead of the label. */
  thinking: boolean;
  label: string;
  isStreaming?: boolean;
  /** Smaller plain text. A Markdown summary sets its own size, so its classes
   *  come through `markdownClassName`. */
  compact?: boolean;
  markdownClassName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            open && "rotate-90"
          )}
          aria-hidden="true"
        />
        <Brain
          className="h-3.5 w-3.5"
          aria-hidden="true"
        />
        {thinking ? <span className="thinking-shimmer">Thinking…</span> : label}
      </button>
      {open &&
        (reasoning.markdown ? (
          <div className="mt-2 border-l-2 border-border pl-3 text-muted-foreground">
            <MarkdownContent
              content={reasoning.text}
              isStreaming={isStreaming}
              rawHtml={false}
              className={cn(markdownClassName, PANEL_HEADINGS)}
            />
          </div>
        ) : (
          <div
            className={cn(
              "mt-2 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground",
              compact && "text-xs leading-5"
            )}
          >
            {reasoning.text}
          </div>
        ))}
    </div>
  );
}
