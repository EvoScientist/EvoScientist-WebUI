import type { FilePaneMode } from "@/lib/filePane";

const KEY = "evoscientist-file-pane-widths";
const MIN_WIDTH = 20; // the inspector panel's minSize
const MAX_WIDTH = 80;

export type PaneWidths = Record<FilePaneMode, number>;

/** Inspector width per mode, as a percentage of the panel group. */
export const DEFAULT_PANE_WIDTHS: PaneWidths = { tree: 26, preview: 45 };

const valid = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isFinite(n) &&
  n >= MIN_WIDTH &&
  n <= MAX_WIDTH;

/** Per-viewer convenience: falls back to the defaults whenever storage fails. */
export function readPaneWidths(): PaneWidths {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(KEY) ?? "{}"
    ) as Partial<PaneWidths>;
    return {
      tree: valid(parsed.tree) ? parsed.tree : DEFAULT_PANE_WIDTHS.tree,
      preview: valid(parsed.preview)
        ? parsed.preview
        : DEFAULT_PANE_WIDTHS.preview,
    };
  } catch {
    return { ...DEFAULT_PANE_WIDTHS };
  }
}

export function savePaneWidth(mode: FilePaneMode, width: number): void {
  if (!valid(width)) return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...readPaneWidths(), [mode]: width })
    );
  } catch {
    // Storage unavailable: the width just isn't remembered.
  }
}

/** Cap the inspector so the chat column keeps at least `minChatPx`. */
export function clampInspectorWidth(
  width: number,
  groupPx: number,
  otherPercent: number,
  minChatPx = 360
): number {
  if (groupPx <= 0) return width;
  const max = 100 - otherPercent - (minChatPx / groupPx) * 100;
  return Math.max(MIN_WIDTH, Math.min(width, Math.floor(max)));
}
