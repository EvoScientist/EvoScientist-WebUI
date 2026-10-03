"use client";

import React, { useState } from "react";
import { ArrowLeft, Bot, Brain, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MemoryFileView } from "@/app/components/MemoryFileView";
import { StateFileView } from "@/app/components/StateFileView";
import { WorkspaceFileView } from "@/app/components/WorkspaceFileView";
import { fileNameOf } from "@/lib/fileKinds";
import type { FileSource, FileTab } from "@/lib/filePane";
import { cn } from "@/lib/utils";
import { useFilePane } from "@/providers/filePaneContext";

const SOURCE_ICON: Record<FileSource, typeof FileText> = {
  workspace: FileText,
  memory: Brain,
  state: Bot,
};

/**
 * The inspector's file preview: "Files" back to the tree, a tab per open file,
 * and every tab's view kept mounted (hidden unless shown) so drafts and scroll
 * positions survive switching tabs.
 */
export function FilePreviewPane() {
  const pane = useFilePane();
  const [closing, setClosing] = useState<FileTab | null>(null);
  if (!pane) return null;
  const {
    state,
    activate,
    close,
    showTree,
    setDirty,
    refreshTick,
    bumpTreeRevision,
    drafts,
    chat,
  } = pane;

  const requestClose = (tab: FileTab) =>
    tab.dirty ? setClosing(tab) : close(tab.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 max-sm:min-h-11"
          onClick={showTree}
          aria-label="Back to files"
        >
          <ArrowLeft
            className="mr-1 size-4"
            aria-hidden="true"
          />
          Files
        </Button>
        <div
          role="tablist"
          aria-label="Open files"
          className="scrollbar-pretty flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {state.tabs.map((tab) => {
            const Icon = SOURCE_ICON[tab.source];
            const selected = tab.id === state.activeId;
            const name = fileNameOf(tab.path);
            return (
              <div
                key={tab.id}
                className={cn(
                  "flex max-w-[12rem] shrink-0 items-center rounded-md border text-xs",
                  selected
                    ? "border-[var(--brand)] bg-background text-foreground"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={tab.path}
                  onClick={() => activate(tab.id)}
                  className="flex min-w-0 items-center gap-1 py-1 pl-2 pr-1 max-sm:min-h-11"
                >
                  <Icon
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{name}</span>
                  {tab.dirty && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-[var(--brand)]"
                      aria-label="Unsaved changes"
                    />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  onClick={() => requestClose(tab)}
                  className="rounded p-1 hover:bg-accent max-sm:min-h-11 max-sm:min-w-11"
                >
                  <X
                    className="size-3"
                    aria-hidden="true"
                  />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {state.tabs.map((tab) => {
          const shown = tab.id === state.activeId;
          const visible = shown && state.mode === "preview";
          return (
            <div
              key={tab.id}
              hidden={!shown}
              className="h-full p-3"
            >
              {tab.source === "workspace" ? (
                <WorkspaceFileView
                  tabId={tab.id}
                  path={tab.path}
                  size={tab.size}
                  visible={visible}
                  refreshTick={refreshTick}
                  drafts={drafts}
                  onDirtyChange={setDirty}
                  onClose={close}
                  onTreeChanged={bumpTreeRevision}
                />
              ) : tab.source === "memory" ? (
                <MemoryFileView
                  tabId={tab.id}
                  path={tab.path}
                  visible={visible}
                  refreshTick={refreshTick}
                  onClose={close}
                />
              ) : (
                <StateFileView
                  tabId={tab.id}
                  path={tab.path}
                  chat={chat}
                  drafts={drafts}
                  onDirtyChange={setDirty}
                  onClose={close}
                />
              )}
            </div>
          );
        })}
      </div>

      <Dialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your edits to “{closing ? fileNameOf(closing.path) : ""}” have not
              been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClosing(null)}
            >
              Keep Editing
            </Button>
            <Button
              onClick={() => {
                if (closing) close(closing.id);
                setClosing(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
