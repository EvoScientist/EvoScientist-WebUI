"use client";

import { useEffect, useRef } from "react";
import { X, FolderOpen, Bot } from "lucide-react";
import { useQueryState } from "nuqs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspacePanel } from "@/app/components/WorkspacePanel";
import { AgentsPanel } from "@/app/components/AgentsPanel";
import { FilePreviewPane } from "@/app/components/FilePreviewPane";
import type { MainChatReporter } from "@/lib/asyncAgents";
import { useFilePane } from "@/providers/filePaneContext";

interface InspectorPanelProps {
  onClose: () => void;
  // Loop a finished async agent's result back to the main chat (Agents tab).
  // Null when the chat view isn't mounted (e.g. viewing Skills/Memory).
  onReportToMainChat?: MainChatReporter | null;
}

type InspectorTab = "workspace" | "agents";

/**
 * Dockable right-hand inspector with tabs:
 *  - Workspace: the on-disk workspace browser, or the docked preview of the
 *    files opened from it, from the chat, or from the memory view.
 *  - Agents: background async sub-agents (writing / data-analysis) this
 *    conversation launched, with live status + steps.
 * The active tab is mirrored to the `inspectorTab` URL param so the composer's
 * "agents running" indicator can deep-link straight to the Agents tab.
 */
export function InspectorPanel({
  onClose,
  onReportToMainChat,
}: InspectorPanelProps) {
  const [tabParam, setTab] = useQueryState("inspectorTab");
  const tab: InspectorTab = tabParam === "agents" ? "agents" : "workspace";
  const pane = useFilePane();
  const previewing =
    tab === "workspace" &&
    pane?.state.mode === "preview" &&
    pane.state.activeId !== null;

  // Keep keyboard focus on what's shown: move it to the file's tab when the
  // user opens a file, and to the other side when the control that had it
  // is hidden or removed (tree ⇄ preview, closing a tab).
  const treeRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const activeId = pane?.state.activeId ?? null;
  const focusRequest = pane?.focusRequest ?? 0;
  const takeFocusRequest = pane?.takeFocusRequest;
  useEffect(() => {
    if (tab !== "workspace") return;
    const requested = takeFocusRequest?.() ?? false;
    const last = lastFocusRef.current;
    const hiddenSide = previewing ? treeRef.current : previewRef.current;
    const lost =
      last !== null &&
      (document.activeElement === last ||
        document.activeElement === document.body) &&
      (!last.isConnected || !!hiddenSide?.contains(last));
    if (!requested && !lost) return;
    const target = previewing
      ? previewRef.current?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]'
        )
      : treeRef.current?.querySelector<HTMLElement>("button, a[href]");
    if (!target) return;
    target.focus();
    // A window without focus fires no focus event for this: note it here.
    if (document.activeElement === target) lastFocusRef.current = target;
  }, [tab, previewing, activeId, focusRequest, takeFocusRequest]);

  return (
    <div
      className="flex h-full flex-col border-l border-border bg-sidebar"
      data-file-pane={previewing ? "preview" : "tree"}
      onFocus={(e) => {
        lastFocusRef.current = e.target as HTMLElement;
      }}
    >
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
      {tab === "agents" && (
        <div className="min-h-0 flex-1 overflow-hidden p-3">
          <AgentsPanel onReportToMainChat={onReportToMainChat} />
        </div>
      )}
      {/* Tree and preview both stay mounted: the tree keeps its expanded
          folders, the preview its drafts and scroll positions. */}
      <div
        ref={treeRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-3",
          (tab !== "workspace" || previewing) && "hidden"
        )}
      >
        <WorkspacePanel />
      </div>
      {pane && pane.state.tabs.length > 0 && (
        <div
          ref={previewRef}
          className={cn(
            "min-h-0 flex-1 overflow-hidden",
            !previewing && "hidden"
          )}
        >
          <FilePreviewPane />
        </div>
      )}
    </div>
  );
}
