"use client";

import { useEffect, type RefObject } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { ResizableHandle } from "@/components/ui/resizable";
import type { FilePaneMode } from "@/lib/filePane";
import {
  clampInspectorWidth,
  readPaneWidths,
  savePaneWidth,
} from "@/lib/filePaneWidths";
import { useFilePane } from "@/providers/filePaneContext";

// A just-opened inspector (or one next to a sidebar that just came or went)
// is laid out by the panel group after this sizer runs, at its default or
// autosaved size; check over the next few frames and size it again until the
// width holds.
const MAX_SETTLE_FRAMES = 10;

/** What the inspector is sized for: the file tree, or a file preview. */
function useInspectorMode(workspaceTab: boolean): FilePaneMode {
  const pane = useFilePane();
  return workspaceTab && pane?.state.mode === "preview" && pane.state.activeId
    ? "preview"
    : "tree";
}

/**
 * Sizes the docked inspector for what it shows: the file tree at its usual
 * width, a file preview wider — capped so the chat keeps room, and applied
 * again when the window or the sidebar changes.
 */
export function FilePaneSizer({
  panelRef,
  sidebarRef,
  sidebarOpen,
  workspaceTab,
  inspectorOpen,
}: {
  panelRef: RefObject<ImperativePanelHandle | null>;
  sidebarRef: RefObject<ImperativePanelHandle | null>;
  sidebarOpen: boolean;
  workspaceTab: boolean;
  inspectorOpen: boolean;
}) {
  const mode = useInspectorMode(workspaceTab);

  useEffect(() => {
    if (!inspectorOpen || !panelRef.current) return;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      const panel = panelRef.current;
      if (!panel) return;
      const target = clampInspectorWidth(
        readPaneWidths()[mode],
        window.innerWidth,
        sidebarRef.current?.getSize() ?? 0
      );
      panel.resize(target);
      let frames = 0;
      const settle = () => {
        const current = panelRef.current;
        if (!current) return;
        if (
          Math.abs(current.getSize() - target) > 0.5 &&
          ++frames < MAX_SETTLE_FRAMES
        ) {
          current.resize(target);
          frame = requestAnimationFrame(settle);
        }
      };
      frame = requestAnimationFrame(settle);
    };
    apply();
    const onWindowResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      cancelAnimationFrame(frame);
    };
  }, [mode, inspectorOpen, sidebarOpen, panelRef, sidebarRef]);

  return null;
}

// Keys the resize handle moves the panel with.
const RESIZE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/**
 * The inspector's resize handle. Only a width the user sets here is
 * remembered (per mode): the panel's own resize events also fire for layouts
 * the group restores and for widths the sizer applies.
 */
export function InspectorResizeHandle({
  panelRef,
  workspaceTab,
}: {
  panelRef: RefObject<ImperativePanelHandle | null>;
  workspaceTab: boolean;
}) {
  const mode = useInspectorMode(workspaceTab);
  const remember = () => {
    const size = panelRef.current?.getSize();
    if (size != null) savePaneWidth(mode, size);
  };
  return (
    <ResizableHandle
      onDragging={(dragging) => {
        if (!dragging) remember();
      }}
      onKeyUp={(e) => {
        if (RESIZE_KEYS.has(e.key)) remember();
      }}
    />
  );
}
