"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useQueryState } from "nuqs";
import { FILE_LINK_EVENT, type FileLinkEventDetail } from "@/lib/fileLink";
import {
  filePaneReducer,
  initialFilePaneState,
  parseFileParam,
  type FileRef,
} from "@/lib/filePane";
import {
  FilePaneContext,
  type ChatFilesBridge,
  type Draft,
  type DraftStore,
  type FilePaneContextValue,
} from "@/providers/filePaneContext";

function sameBridge(
  a: ChatFilesBridge | null,
  b: ChatFilesBridge | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.threadId !== b.threadId ||
    a.setFiles !== b.setFiles ||
    a.editDisabled !== b.editDisabled
  ) {
    return false;
  }
  const keys = Object.keys(a.files);
  return (
    keys.length === Object.keys(b.files).length &&
    keys.every((k) => a.files[k] === b.files[k])
  );
}

/**
 * Page-level state of the docked file preview. Wraps both the chat column and
 * the inspector (siblings in page.tsx), so either side can open files and the
 * pane can reach the chat's agent-state files.
 */
export function FilePaneProvider({
  children,
  onReveal,
}: {
  children: React.ReactNode;
  /** Show the inspector's Workspace tab, opening the inspector if needed. */
  onReveal?: () => void;
}) {
  const [state, dispatch] = useReducer(filePaneReducer, initialFilePaneState);
  const [fileParam, setFileParam] = useQueryState("file");
  const [refreshTick, setRefreshTick] = useState(0);
  const [treeRevision, setTreeRevision] = useState(0);
  const [chat, setChat] = useState<ChatFilesBridge | null>(null);

  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    onRevealRef.current = onReveal;
  }, [onReveal]);

  // Focus follows a file the user opened, not one restored from the URL.
  const [focusRequest, setFocusRequest] = useState(0);
  const focusPendingRef = useRef(false);
  const reveal = useCallback((ref: FileRef, takeFocus: boolean) => {
    dispatch({ type: "open", ref });
    if (takeFocus) {
      focusPendingRef.current = true;
      setFocusRequest((n) => n + 1);
    }
    onRevealRef.current?.();
  }, []);
  const open = useCallback((ref: FileRef) => reveal(ref, true), [reveal]);
  const takeFocusRequest = useCallback(() => {
    const pending = focusPendingRef.current;
    focusPendingRef.current = false;
    return pending;
  }, []);

  // File links in any MarkdownContent (chat, memory view, agents panel).
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const detail = (e as CustomEvent<FileLinkEventDetail>).detail;
      if (!detail) return;
      open({
        source: detail.kind === "memory" ? "memory" : "workspace",
        path: detail.path,
      });
    };
    window.addEventListener(FILE_LINK_EVENT, onOpenFile);
    return () => window.removeEventListener(FILE_LINK_EVENT, onOpenFile);
  }, [open]);

  // URL → pane, for a `file` param we didn't write: page load, back/forward,
  // a shared link.
  const writtenRef = useRef<string | null>(null);
  useEffect(() => {
    if (fileParam === writtenRef.current) return;
    if (fileParam === null) {
      dispatch({ type: "showTree" });
      return;
    }
    const ref = parseFileParam(fileParam);
    if (!ref) {
      writtenRef.current = null;
      void setFileParam(null);
      return;
    }
    reveal(ref, false);
  }, [fileParam, reveal, setFileParam]);

  // Pane → URL: the file on show. Skipped on mount so the URL is read first.
  const shown = state.mode === "preview" ? state.activeId : null;
  const prevShownRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevShownRef.current === undefined) {
      prevShownRef.current = shown;
      return;
    }
    if (prevShownRef.current === shown) return;
    prevShownRef.current = shown;
    writtenRef.current = shown;
    void setFileParam(shown);
  }, [shown, setFileParam]);

  // Drafts live outside React state: typing must not re-render every
  // consumer. Closed tabs' drafts are dropped.
  const draftsRef = useRef(new Map<string, Draft>());
  const drafts = useMemo<DraftStore>(
    () => ({
      get: (id) => draftsRef.current.get(id),
      set: (id, draft) => {
        if (draft === undefined) draftsRef.current.delete(id);
        else draftsRef.current.set(id, draft);
      },
    }),
    []
  );
  useEffect(() => {
    const openIds = new Set(state.tabs.map((t) => t.id));
    for (const id of draftsRef.current.keys()) {
      if (!openIds.has(id)) draftsRef.current.delete(id);
    }
  }, [state.tabs]);

  // Agent-state files belong to one conversation: close their tabs when the
  // chat moves to another. A new chat getting its first id is the same one.
  const lastThreadRef = useRef<string | null | undefined>(undefined);
  const registerChat = useCallback((bridge: ChatFilesBridge | null) => {
    setChat((prev) => (sameBridge(prev, bridge) ? prev : bridge));
    if (!bridge) return;
    const last = lastThreadRef.current;
    if (last !== undefined && last !== null && last !== bridge.threadId) {
      dispatch({ type: "closeSource", source: "state" });
    }
    lastThreadRef.current = bridge.threadId;
  }, []);

  const notifyFilesMayHaveChanged = useCallback(
    () => setRefreshTick((t) => t + 1),
    []
  );
  const bumpTreeRevision = useCallback(() => setTreeRevision((r) => r + 1), []);
  const activate = useCallback(
    (id: string) => dispatch({ type: "activate", id }),
    []
  );
  const close = useCallback((id: string) => {
    draftsRef.current.delete(id);
    dispatch({ type: "close", id });
  }, []);
  const showTree = useCallback(() => dispatch({ type: "showTree" }), []);
  const showPreview = useCallback(() => dispatch({ type: "showPreview" }), []);
  const setDirty = useCallback(
    (id: string, dirty: boolean) => dispatch({ type: "setDirty", id, dirty }),
    []
  );

  const value = useMemo<FilePaneContextValue>(
    () => ({
      state,
      activeTab: state.tabs.find((t) => t.id === state.activeId) ?? null,
      open,
      focusRequest,
      takeFocusRequest,
      activate,
      close,
      showTree,
      showPreview,
      setDirty,
      refreshTick,
      notifyFilesMayHaveChanged,
      treeRevision,
      bumpTreeRevision,
      drafts,
      chat,
      registerChat,
    }),
    [
      state,
      open,
      focusRequest,
      takeFocusRequest,
      activate,
      close,
      showTree,
      showPreview,
      setDirty,
      refreshTick,
      notifyFilesMayHaveChanged,
      treeRevision,
      bumpTreeRevision,
      drafts,
      chat,
      registerChat,
    ]
  );

  return (
    <FilePaneContext.Provider value={value}>
      {children}
    </FilePaneContext.Provider>
  );
}
