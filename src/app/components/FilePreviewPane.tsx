"use client";

import React, { useId, useRef, useState } from "react";
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
  const baseId = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  // What had focus when the discard dialog opened, to give it back to.
  const closeInvokerRef = useRef<HTMLElement | null>(null);
  if (!pane) return null;
  const {
    state,
    activate,
    close,
    requestFocus,
    showTree,
    setDirty,
    refreshTick,
    bumpTreeRevision,
    drafts,
    chat,
  } = pane;

  // A close that takes focus with it (the tab, or a close button the click
  // focused) asks for it back: the inspector hands it to what shows next. With
  // unsaved edits that waits for the dialog.
  const requestClose = (tab: FileTab, hadFocus: boolean) => {
    if (!tab.dirty) {
      close(tab.id);
      if (hadFocus) requestFocus();
      return;
    }
    closeInvokerRef.current = document.activeElement as HTMLElement | null;
    setClosing(tab);
  };

  const tabDomId = (id: string) => `${baseId}-tab-${encodeURIComponent(id)}`;
  const panelDomId = (id: string) =>
    `${baseId}-panel-${encodeURIComponent(id)}`;
  // The tabs pattern: one tab stop, arrows and Home / End move and show,
  // Delete closes (Backspace too: a Mac's Delete key).
  const tabStopId = state.tabs.some((t) => t.id === state.activeId)
    ? state.activeId
    : state.tabs[0]?.id ?? null;
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    const tabs = state.tabs;
    const show = (to: number) => {
      const next = tabs[(to + tabs.length) % tabs.length];
      activate(next.id);
      tabRefs.current.get(next.id)?.focus();
    };
    switch (e.key) {
      case "ArrowRight":
        show(index + 1);
        break;
      case "ArrowLeft":
        show(index - 1);
        break;
      case "Home":
        show(0);
        break;
      case "End":
        show(tabs.length - 1);
        break;
      case "Delete":
      case "Backspace":
        requestClose(tabs[index], true);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 max-md:min-h-11"
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
          {state.tabs.map((tab, index) => {
            const Icon = SOURCE_ICON[tab.source];
            const selected = tab.id === state.activeId;
            const name = fileNameOf(tab.path);
            return (
              <div
                key={tab.id}
                role="presentation"
                className={cn(
                  "flex max-w-[12rem] shrink-0 items-center rounded-md border text-xs",
                  selected
                    ? "border-[var(--brand)] bg-background text-foreground"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                <button
                  ref={(el) => {
                    if (el) tabRefs.current.set(tab.id, el);
                    else tabRefs.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  id={tabDomId(tab.id)}
                  aria-selected={selected}
                  aria-controls={panelDomId(tab.id)}
                  tabIndex={tab.id === tabStopId ? 0 : -1}
                  title={tab.path}
                  onClick={() => activate(tab.id)}
                  onKeyDown={(e) => onTabKeyDown(e, index)}
                  className="flex min-w-0 items-center gap-1 py-1 pl-2 pr-1 max-md:min-h-11"
                >
                  <Icon
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{name}</span>
                  {tab.dirty && (
                    <>
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-[var(--brand)]"
                        aria-hidden="true"
                      />
                      <span className="sr-only">, unsaved changes</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  // Only the shown tab's: Tab goes from the tab to its close
                  // button and out, and Delete closes any tab.
                  tabIndex={selected ? 0 : -1}
                  onClick={(e) =>
                    requestClose(
                      tab,
                      e.currentTarget === document.activeElement
                    )
                  }
                  className="rounded p-1 hover:bg-accent max-md:min-h-11 max-md:min-w-11"
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
              id={panelDomId(tab.id)}
              role="tabpanel"
              aria-labelledby={tabDomId(tab.id)}
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
        <DialogContent
          className="sm:max-w-md"
          // Radix gives focus back to the dialog's trigger, and this dialog
          // has none: give it to what asked, or once that tab is gone, let
          // the inspector pick.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const invoker = closeInvokerRef.current;
            closeInvokerRef.current = null;
            if (invoker?.isConnected && invoker !== document.body) {
              invoker.focus();
            } else {
              requestFocus();
            }
          }}
        >
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
