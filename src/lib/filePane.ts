/**
 * State for the docked file preview in the inspector: which files are open
 * as tabs, which one is shown, and whether the Workspace tab shows the file
 * tree or the preview. Pure — the React side is FilePaneProvider.
 */

export type FileSource = "workspace" | "memory" | "state";

export interface FileRef {
  source: FileSource;
  /** Workspace-relative path, memory-root-relative path, or agent-state key. */
  path: string;
  /** Byte size from the workspace listing, when the opener knows it. */
  size?: number;
}

export interface FileTab extends FileRef {
  id: string;
  /** Activation stamp; the lowest belongs to the tab unseen the longest. */
  lastActive: number;
  /** Holds unsaved edits: never evicted, and closing it asks first. */
  dirty: boolean;
}

export type FilePaneMode = "tree" | "preview";

export interface FilePaneState {
  tabs: FileTab[];
  activeId: string | null;
  mode: FilePaneMode;
  /** Source of `lastActive` stamps. */
  clock: number;
}

export type FilePaneAction =
  | { type: "open"; ref: FileRef }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "closeSource"; source: FileSource }
  | { type: "showTree" }
  | { type: "showPreview" }
  | { type: "setDirty"; id: string; dirty: boolean };

export const MAX_TABS = 8;

export const initialFilePaneState: FilePaneState = {
  tabs: [],
  activeId: null,
  mode: "tree",
  clock: 0,
};

const SOURCES: readonly FileSource[] = ["workspace", "memory", "state"];

/** Tab id, and the value of the `file` URL param: `<source>:<path>`. */
export function fileTabId(ref: Pick<FileRef, "source" | "path">): string {
  return `${ref.source}:${ref.path}`;
}

/** Parse a `file` URL param; null for anything that isn't `<source>:<path>`. */
export function parseFileParam(
  value: string | null
): Pick<FileRef, "source" | "path"> | null {
  if (!value) return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const source = value.slice(0, colon) as FileSource;
  const path = value.slice(colon + 1);
  if (!SOURCES.includes(source) || !path.trim()) return null;
  // Same rule the file APIs apply to names: no control characters.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return { source, path };
}

/** Show `id` without changing the mode. */
function focus(state: FilePaneState, id: string): FilePaneState {
  const clock = state.clock + 1;
  return {
    ...state,
    clock,
    activeId: id,
    tabs: state.tabs.map((t) =>
      t.id === id ? { ...t, lastActive: clock } : t
    ),
  };
}

/** Drop the longest-unseen clean tabs until at most MAX_TABS remain. */
function evict(state: FilePaneState): FilePaneState {
  let tabs = state.tabs;
  while (tabs.length > MAX_TABS) {
    const candidates = tabs.filter((t) => !t.dirty && t.id !== state.activeId);
    if (candidates.length === 0) break;
    const oldest = candidates.reduce((a, b) =>
      b.lastActive < a.lastActive ? b : a
    );
    tabs = tabs.filter((t) => t.id !== oldest.id);
  }
  return tabs === state.tabs ? state : { ...state, tabs };
}

function withoutTabs(
  state: FilePaneState,
  tabs: FileTab[],
  next: FileTab | undefined
): FilePaneState {
  if (!next) return { ...state, tabs, activeId: null, mode: "tree" };
  return focus({ ...state, tabs }, next.id);
}

export function filePaneReducer(
  state: FilePaneState,
  action: FilePaneAction
): FilePaneState {
  switch (action.type) {
    case "open": {
      const id = fileTabId(action.ref);
      const existing = state.tabs.find((t) => t.id === id);
      let next = state;
      if (!existing) {
        const tab: FileTab = {
          source: action.ref.source,
          path: action.ref.path,
          size: action.ref.size,
          id,
          lastActive: 0,
          dirty: false,
        };
        next = { ...state, tabs: [...state.tabs, tab] };
      } else if (
        action.ref.size !== undefined &&
        action.ref.size !== existing.size
      ) {
        next = {
          ...state,
          tabs: state.tabs.map((t) =>
            t.id === id ? { ...t, size: action.ref.size } : t
          ),
        };
      }
      return evict({ ...focus(next, id), mode: "preview" });
    }
    case "activate":
      return state.tabs.some((t) => t.id === action.id)
        ? { ...focus(state, action.id), mode: "preview" }
        : state;
    case "close": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      return withoutTabs(state, tabs, tabs[index] ?? tabs[index - 1]);
    }
    case "closeSource": {
      const tabs = state.tabs.filter((t) => t.source !== action.source);
      if (tabs.length === state.tabs.length) return state;
      if (tabs.some((t) => t.id === state.activeId)) return { ...state, tabs };
      const recent = tabs.length
        ? tabs.reduce((a, b) => (b.lastActive > a.lastActive ? b : a))
        : undefined;
      return withoutTabs(state, tabs, recent);
    }
    case "showTree":
      return state.mode === "tree" ? state : { ...state, mode: "tree" };
    case "showPreview":
      return state.activeId && state.mode !== "preview"
        ? { ...state, mode: "preview" }
        : state;
    case "setDirty": {
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab || tab.dirty === action.dirty) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.id ? { ...t, dirty: action.dirty } : t
        ),
      };
    }
  }
}
