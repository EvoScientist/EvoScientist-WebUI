"use client";

import { X, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspacePanel } from "@/app/components/WorkspacePanel";

interface InspectorPanelProps {
  onClose: () => void;
}

/**
 * Dockable right-hand inspector. Currently a single Workspace destination —
 * the Agents tab was retired once the persona chip strip + focus view covered
 * the same async-task status/steps, and auto-report to the main chat became
 * the single (always-on) path for finished tasks.
 */
export function InspectorPanel({ onClose }: InspectorPanelProps) {
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
            aria-selected={true}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "bg-accent text-foreground"
            )}
          >
            <FolderOpen
              className="size-4 text-[var(--brand)]"
              aria-hidden="true"
            />
            Workspace
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
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <WorkspacePanel />
      </div>
    </div>
  );
}
