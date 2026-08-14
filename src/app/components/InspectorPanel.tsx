"use client";

import { X, FolderOpen, Bot, Sparkles } from "lucide-react";
import { useQueryState } from "nuqs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspacePanel } from "@/app/components/WorkspacePanel";
import { AgentsPanel } from "@/app/components/AgentsPanel";
import { ExpertsPanel } from "@/app/components/ExpertsPanel";
import type { MainChatReporter } from "@/lib/asyncAgents";

interface InspectorPanelProps {
  onClose: () => void;
  // Loop a finished async agent's result back to the main chat (Agents tab).
  // Null when the chat view isn't mounted (e.g. viewing Skills/Memory).
  onReportToMainChat?: MainChatReporter | null;
}

type InspectorTab = "workspace" | "agents" | "experts";

/**
 * Dockable right-hand inspector with tabs:
 *  - Workspace: the on-disk workspace browser.
 *  - Agents: background async sub-agents (writing / data-analysis) this
 *    conversation launched, with live status + steps.
 *  - Experts: gallery of user-summonable teams. Clicking Summon writes the
 *    team name into the thread's `active_teams` metadata (via useChat) so
 *    subsequent runs bias delegation toward that team.
 * The active tab is mirrored to the `inspectorTab` URL param so the composer's
 * "agents running" indicator or the active-team chip can deep-link straight
 * to the right tab.
 */
export function InspectorPanel({
  onClose,
  onReportToMainChat,
}: InspectorPanelProps) {
  const [tabParam, setTab] = useQueryState("inspectorTab");
  const tab: InspectorTab =
    tabParam === "agents"
      ? "agents"
      : tabParam === "experts"
      ? "experts"
      : "workspace";

  return (
    <div className="flex h-full flex-col border-l border-border bg-sidebar">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <div
          role="tablist"
          aria-label="Inspector"
          className="flex items-center gap-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "workspace"}
            onClick={() => setTab(null)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === "workspace"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <FolderOpen
              className="size-4 text-[var(--brand)]"
              aria-hidden="true"
            />
            Workspace
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "agents"}
            onClick={() => setTab("agents")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === "agents"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Bot
              className="size-4 text-[var(--brand)]"
              aria-hidden="true"
            />
            Agents
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "experts"}
            onClick={() => setTab("experts")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === "experts"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Sparkles
              className="size-4 text-[var(--brand)]"
              aria-hidden="true"
            />
            Experts
          </button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close inspector"
          title="Close"
        >
          <X
            className="size-4"
            aria-hidden="true"
          />
        </Button>
      </div>
      {tab === "agents" ? (
        <div className="min-h-0 flex-1 overflow-hidden p-3">
          <AgentsPanel onReportToMainChat={onReportToMainChat} />
        </div>
      ) : tab === "experts" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ExpertsPanel />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <WorkspacePanel />
        </div>
      )}
    </div>
  );
}
