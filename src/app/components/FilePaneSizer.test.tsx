// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { FilePaneSizer, InspectorResizeHandle } from "./FilePaneSizer";
import { renderWithFilePane } from "@/test/filePaneHarness";
import {
  DEFAULT_PANE_WIDTHS,
  readPaneWidths,
  savePaneWidth,
} from "@/lib/filePaneWidths";

// The real handle needs a panel group; keep what the page wires into it.
const handle = vi.hoisted(() => ({
  onDragging: undefined as ((dragging: boolean) => void) | undefined,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: ({
    onDragging,
    onKeyUp,
  }: {
    onDragging?: (dragging: boolean) => void;
    onKeyUp?: React.KeyboardEventHandler;
  }) => {
    handle.onDragging = onDragging;
    return (
      <div
        role="separator"
        tabIndex={0}
        onKeyUp={onKeyUp}
      />
    );
  },
}));

const nextFrame = () =>
  act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  );

const setWindowWidth = (value: number) =>
  Object.defineProperty(window, "innerWidth", { value, configurable: true });

// A panel that keeps the size it is given, like the real one.
function fakePanel(size: number) {
  const panel = { size };
  const resize = vi.fn((next: number) => {
    panel.size = next;
  });
  const ref = {
    current: {
      resize,
      getSize: () => panel.size,
    } as unknown as ImperativePanelHandle,
  };
  return { panel, resize, ref };
}

function setup(workspaceTab = true, inspectorOpen = true) {
  const { panel, resize, ref: panelRef } = fakePanel(26);
  const sidebar = fakePanel(0);
  // Opening the inspector or the sidebar re-renders only the sizer, as in
  // page.tsx.
  let setOpen: (open: boolean) => void = () => {};
  let setSidebar: (open: boolean) => void = () => {};
  function SizerHost() {
    const [open, set] = useState(inspectorOpen);
    const [sidebarOpen, setSide] = useState(false);
    setOpen = set;
    setSidebar = setSide;
    return (
      <>
        <FilePaneSizer
          panelRef={panelRef}
          sidebarRef={sidebar.ref}
          sidebarOpen={sidebarOpen}
          workspaceTab={workspaceTab}
          inspectorOpen={open}
        />
        <InspectorResizeHandle
          panelRef={panelRef}
          workspaceTab={workspaceTab}
        />
      </>
    );
  }
  const h = renderWithFilePane(<SizerHost />);
  return {
    h,
    panel,
    resize,
    sidebar: sidebar.panel,
    setInspectorOpen: (open: boolean) => act(() => setOpen(open)),
    setSidebarOpen: (open: boolean) => act(() => setSidebar(open)),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  setWindowWidth(1600);
});

describe("FilePaneSizer", () => {
  it("widens for a preview and narrows back for the tree", () => {
    const { h, resize } = setup();
    expect(resize).toHaveBeenLastCalledWith(26);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    expect(resize).toHaveBeenLastCalledWith(45);
    act(() => h.pane().showTree());
    expect(resize).toHaveBeenLastCalledWith(26);
  });

  it("uses the width the user dragged the preview to", () => {
    savePaneWidth("preview", 60);
    const { h, resize } = setup();
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    expect(resize).toHaveBeenLastCalledWith(60);
  });

  it("re-applies the width after the panel group lays out a just-opened inspector", async () => {
    // Opening a file from a chat link also opens the inspector: the panel
    // group then lays the new panel out at its default size after the sizer
    // has run, and that size must not stick.
    const { h, panel, setInspectorOpen } = setup(true, false);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    setInspectorOpen(true);
    expect(panel.size).toBe(45);
    panel.size = 26; // the group's own layout lands
    await nextFrame();
    await nextFrame();
    expect(panel.size).toBe(45);
  });

  it("re-applies the width when the sidebar opens or closes", async () => {
    // The group restores its saved layout for the new set of panels, which
    // knows nothing of what the inspector shows.
    const { h, panel, sidebar, setSidebarOpen } = setup();
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    await nextFrame(); // the width has settled
    sidebar.size = 23;
    setSidebarOpen(true);
    panel.size = 26; // the group's restored layout
    await nextFrame();
    expect(panel.size).toBe(45);
    sidebar.size = 0;
    setSidebarOpen(false);
    panel.size = 30;
    await nextFrame();
    expect(panel.size).toBe(45);
    expect(readPaneWidths()).toEqual(DEFAULT_PANE_WIDTHS);
  });

  it("re-caps the preview when the window narrows, and restores it", async () => {
    const { h, panel } = setup();
    savePaneWidth("preview", 70);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    expect(panel.size).toBe(70);
    setWindowWidth(800);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await nextFrame();
    // 360px of 800px is 45%: at most 55%.
    expect(panel.size).toBe(55);
    setWindowWidth(1600);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await nextFrame();
    expect(panel.size).toBe(70);
    expect(readPaneWidths().preview).toBe(70);
  });

  it("stays at tree width while the Agents tab is showing", () => {
    const { h, resize } = setup(false);
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    expect(resize).toHaveBeenLastCalledWith(26);
  });

  it("caps the preview on a narrow window", () => {
    setWindowWidth(800);
    const { h, resize } = setup();
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    expect(resize).toHaveBeenLastCalledWith(45);
    savePaneWidth("preview", 70);
    act(() => h.pane().showTree());
    act(() => h.pane().showPreview());
    expect(resize).toHaveBeenLastCalledWith(55);
  });
});

describe("InspectorResizeHandle", () => {
  it("remembers the width the user drags to, per mode", () => {
    const { h, panel } = setup();
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    act(() => handle.onDragging?.(true));
    panel.size = 52;
    act(() => handle.onDragging?.(false));
    expect(readPaneWidths()).toEqual({ tree: 26, preview: 52 });

    act(() => h.pane().showTree());
    act(() => handle.onDragging?.(true));
    panel.size = 30;
    act(() => handle.onDragging?.(false));
    expect(readPaneWidths()).toEqual({ tree: 30, preview: 52 });
  });

  it("remembers a width set from the keyboard", () => {
    const { h, panel } = setup();
    act(() => h.pane().open({ source: "workspace", path: "a.md" }));
    panel.size = 50;
    fireEvent.keyUp(screen.getByRole("separator"), { key: "Tab" });
    expect(readPaneWidths().preview).toBe(45);
    fireEvent.keyUp(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(readPaneWidths().preview).toBe(50);
  });
});
