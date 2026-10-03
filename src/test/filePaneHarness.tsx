import React from "react";
import { render } from "@testing-library/react";
import { useQueryState } from "nuqs";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { FilePaneProvider } from "@/providers/FilePaneProvider";
import {
  useFilePane,
  type FilePaneContextValue,
} from "@/providers/filePaneContext";

/**
 * Render `ui` under a FilePaneProvider with in-memory URL state. `pane()` is
 * the live context; `fileParam()` is the current `file` query state;
 * `lastFileParam()` is the `file` param of the latest URL write the adapter
 * reported (undefined before any). The testing adapter doesn't report writes
 * issued while mounting, so assert those through `fileParam()`.
 *
 * Re-render state from inside `ui` (a small stateful host) rather than by
 * re-rendering the tree: the adapter clears nuqs' pending URL writes every
 * time it renders.
 */
export function renderWithFilePane(
  ui: React.ReactNode,
  opts: { searchParams?: string; onReveal?: () => void } = {}
) {
  const urlUpdates: UrlUpdateEvent[] = [];
  const ref: {
    pane: FilePaneContextValue | null;
    fileParam: string | null;
  } = { pane: null, fileParam: null };
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
      <FilePaneProvider onReveal={opts.onReveal}>
        <Probe />
        {ui}
      </FilePaneProvider>
    </NuqsTestingAdapter>
  );
  return {
    ...utils,
    pane: () => {
      if (!ref.pane) throw new Error("FilePaneProvider is not mounted");
      return ref.pane;
    },
    fileParam: () => ref.fileParam,
    lastFileParam: () =>
      urlUpdates.length > 0
        ? urlUpdates[urlUpdates.length - 1].searchParams.get("file")
        : undefined,
  };
}
