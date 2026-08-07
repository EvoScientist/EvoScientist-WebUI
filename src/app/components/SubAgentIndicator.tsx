"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Bot, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import type { SubAgent } from "@/app/types/types";

interface SubAgentIndicatorProps {
  subAgent: SubAgent;
  onToggle: (id: string) => void;
  isExpanded?: boolean;
}

export const SubAgentIndicator = React.memo<SubAgentIndicatorProps>(
  ({ subAgent, onToggle, isExpanded = false }) => {
    const running =
      subAgent.status === "pending" || subAgent.status === "active";
    const status =
      subAgent.status === "error" ? "failed" : running ? "running" : "finished";
    return (
      <div className="w-fit max-w-[70vw] overflow-hidden rounded-lg bg-card">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onToggle(subAgent.id)}
          aria-expanded={isExpanded}
          aria-label={`${subAgent.subAgentName} subagent ${status}`}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        >
          <span className="bg-[var(--brand)]/10 flex size-5 shrink-0 items-center justify-center rounded-md text-[var(--brand)]">
            {running ? (
              <Loader2
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Bot
                className="size-3.5"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="truncate text-sm font-semibold text-foreground">
            {subAgent.subAgentName}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            subagent
          </span>
          {isExpanded ? (
            <ChevronUp
              size={14}
              className="ml-auto shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              size={14}
              className="ml-auto shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </Button>
      </div>
    );
  }
);

SubAgentIndicator.displayName = "SubAgentIndicator";
