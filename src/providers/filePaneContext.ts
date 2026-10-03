"use client";

import { createContext, useContext } from "react";
import type { FilePaneState, FileRef, FileTab } from "@/lib/filePane";

/** What the chat hands the pane about the open conversation's files. */
export interface ChatFilesBridge {
  threadId: string | null;
  /** Agent-state files of the open thread. */
  files: Record<string, string>;
  setFiles: (files: Record<string, string>) => Promise<void>;
  /** A run or an approval is in progress. */
  editDisabled: boolean;
}

/** Unsaved edits, and the file content they were made against. */
export interface Draft {
  text: string;
  base: string;
}

/**
 * Unsaved drafts by tab id; outlive a view that unmounts (inspector closed).
 * The base lets a remounted view tell a disk change from its own edits.
 */
export interface DraftStore {
  get: (tabId: string) => Draft | undefined;
  set: (tabId: string, draft: Draft | undefined) => void;
}

export interface FilePaneContextValue {
  state: FilePaneState;
  activeTab: FileTab | null;
  /**
   * Open (or switch to) a file and reveal the inspector's Workspace tab.
   * The user asked for it, so the file's tab takes focus.
   */
  open: (ref: FileRef) => void;
  /** Bumps when an open asks for focus; see takeFocusRequest. */
  focusRequest: number;
  /** True once per open that asked for focus; whoever shows it focuses. */
  takeFocusRequest: () => boolean;
  activate: (id: string) => void;
  /** Close without asking; callers confirm unsaved edits first. */
  close: (id: string) => void;
  showTree: () => void;
  showPreview: () => void;
  setDirty: (id: string, dirty: boolean) => void;
  /** Bumps whenever the agent may have written files. */
  refreshTick: number;
  notifyFilesMayHaveChanged: () => void;
  /** Bumps after the pane saved or deleted a workspace file. */
  treeRevision: number;
  bumpTreeRevision: () => void;
  drafts: DraftStore;
  chat: ChatFilesBridge | null;
  registerChat: (bridge: ChatFilesBridge | null) => void;
}

export const FilePaneContext = createContext<FilePaneContextValue | null>(null);

/** Null outside a FilePaneProvider (e.g. isolated component tests). */
export function useFilePane(): FilePaneContextValue | null {
  return useContext(FilePaneContext);
}
