"use client";

import React from "react";
import { Bot, Loader2 } from "lucide-react";
import type { SubAgent } from "@/app/types/types";

interface SubAgentIndicatorProps {
  subAgent: SubAgent;
}

export const SubAgentIndicator = React.memo<SubAgentIndicatorProps>(
  ({ subAgent }) => {
    const running = subAgent.status === "pending";
    return (
      <div
        role="status"
        aria-label={`${subAgent.subAgentName} subagent ${
          running ? "running" : "finished"
        }`}
        className="flex w-fit max-w-[70vw] items-center gap-2 overflow-hidden rounded-lg bg-card px-3 py-2"
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
      </div>
    );
  }
);

SubAgentIndicator.displayName = "SubAgentIndicator";
