import React from "react";
import { act, render } from "@testing-library/react";
import { useQueryState } from "nuqs";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { FilePaneProvider } from "@/providers/FilePaneProvider";
import {
  useFilePane,
  type FilePaneContextValue,
} from "@/providers/filePaneContext";
import type { ProjectsContextValue } from "@/providers/ProjectsProvider";
import { TestProjectsProvider } from "@/test/mockProjects";

/**
 * Render `ui` under a FilePaneProvider with in-memory URL state. `pane()` is
 * the live context; `fileParam()` is the current `file` query state;
 * `lastFileParam()` is the `file` param of the latest URL write the adapter
 * reported (undefined before any). The testing adapter doesn't report writes
 * issued while mounting, so assert those through `fileParam()`.
 *
 * Re-render state from inside `ui` (a small stateful host) rather than by
 * re-rendering the tree: the testing adapter clears nuqs' pending URL writes
 * when it mounts (on every render before nuqs 2.10.1), and these tests don't
 * depend on which. `setInspectorOpen` flips the provider's `inspectorOpen`
 * that way (open by default, as in the app while the pane is on screen); pass
 * `ui` as a function of it to mount the inspector only while it is open.
 */
export function renderWithFilePane(
  ui: React.ReactNode | ((inspectorOpen: boolean) => React.ReactNode),
  opts: {
    searchParams?: string;
    onReveal?: () => void;
    inspectorOpen?: boolean;
    inspectorToggleRef?: React.RefObject<HTMLElement | null>;
    projects?: ProjectsContextValue;
  } = {}
) {
  const urlUpdates: UrlUpdateEvent[] = [];
  type InspectorState = { open: boolean; returnFocusOnClose: boolean };
  const ref: {
    pane: FilePaneContextValue | null;
    fileParam: string | null;
    setInspector: ((state: InspectorState) => void) | null;
  } = { pane: null, fileParam: null, setInspector: null };
  function Host() {
    const [inspector, setInspector] = React.useState<InspectorState>({
      open: opts.inspectorOpen ?? true,
      returnFocusOnClose: true,
    });
    ref.setInspector = setInspector;
    return (
      <FilePaneProvider
        onReveal={opts.onReveal}
        inspectorOpen={inspector.open}
        inspectorToggleRef={opts.inspectorToggleRef}
        returnFocusOnClose={inspector.returnFocusOnClose}
      >
        <Probe />
        {typeof ui === "function" ? ui(inspector.open) : ui}
      </FilePaneProvider>
    );
  }
  function Probe() {
    ref.pane = useFilePane();
    [ref.fileParam] = useQueryState("file");
    return null;
  }
  const utils = render(
    <NuqsTestingAdapter
      searchParams={opts.searchParams}
      hasMemory
      onUrlUpdate={(e) => urlUpdates.push(e)}
    >
      <TestProjectsProvider value={opts.projects}>
        <Host />
      </TestProjectsProvider>
    </NuqsTestingAdapter>
  );
  return {
    ...utils,
    pane: () => {
      if (!ref.pane) throw new Error("FilePaneProvider is not mounted");
      return ref.pane;
    },
    fileParam: () => ref.fileParam,
    setInspectorOpen: (
      open: boolean,
      { returnFocusOnClose = true }: { returnFocusOnClose?: boolean } = {}
    ) => act(() => ref.setInspector?.({ open, returnFocusOnClose })),
    lastFileParam: () =>
      urlUpdates.length > 0
        ? urlUpdates[urlUpdates.length - 1].searchParams.get("file")
        : undefined,
  };
}

// jsdom lays nothing out and has no `document.elementFromPoint`. Here it finds
// nothing on screen until `onScreen` gives elements a box and hit-tests
// against those boxes, for code that only hands focus to what the user can
// see; `resetScreen` (afterEach) goes back to nothing on screen.
const boxes = new Map<Element, DOMRect>();
function hitTest(x: number, y: number): Element | null {
  for (const [el, r] of boxes) {
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return el;
    }
  }
  return null;
}
Object.defineProperty(document, "elementFromPoint", {
  configurable: true,
  value: hitTest,
});
export function onScreen(...els: HTMLElement[]) {
  for (const el of els) {
    const top = 10 + boxes.size * 40;
    const rect = {
      x: 10,
      y: top,
      left: 10,
      top,
      right: 110,
      bottom: top + 30,
      width: 100,
      height: 30,
      toJSON: () => ({}),
    } as DOMRect;
    boxes.set(el, rect);
    el.getBoundingClientRect = () => rect;
  }
}
export function resetScreen() {
  boxes.clear();
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: hitTest,
  });
}
