"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileTextContent } from "@/app/components/FileTextContent";
import { useTickRefresh } from "@/app/hooks/useTickRefresh";
import { workspaceFileExists } from "@/lib/fileExistence";
import {
  extOf,
  fileKindOf,
  fileNameOf,
  MAX_INLINE_TEXT_BYTES,
  workspaceFileUrl,
} from "@/lib/fileKinds";
import type { DraftStore } from "@/providers/filePaneContext";

export interface WorkspaceFileViewProps {
  tabId: string;
  /** Path relative to the workspace root. */
  path: string;
  /** Byte size from the listing, when the opener knew it. */
  size?: number;
  /** On screen: the shown tab of a visible preview. */
  visible: boolean;
  /** Bumps when the agent may have written files. */
  refreshTick: number;
  drafts: DraftStore;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  onClose: (tabId: string) => void;
  /** After a save or delete, so the file tree can refresh. */
  onTreeChanged: () => void;
}

type Body =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "too-large" }
  | { state: "missing" }
  | { state: "error"; message: string };

class TooLarge extends Error {}

async function readText(path: string): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(workspaceFileUrl(path), {
    signal: controller.signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Failed to load file (${res.status})`);
  }
  // A chat link doesn't know the size: check before pulling the body in.
  if (Number(res.headers.get("content-length")) > MAX_INLINE_TEXT_BYTES) {
    controller.abort();
    throw new TooLarge();
  }
  return res.text();
}

const TOOLBAR =
  "flex shrink-0 flex-wrap items-center justify-end gap-1 max-sm:[&>a]:min-h-11 max-sm:[&>button]:min-h-11 max-sm:[&>button]:min-w-11";

export function WorkspaceFileView({
  tabId,
  path,
  size,
  visible,
  refreshTick,
  drafts,
  onDirtyChange,
  onClose,
  onTreeChanged,
}: WorkspaceFileViewProps) {
  const name = fileNameOf(path);
  const ext = extOf(name);
  const kind = fileKindOf(ext);
  const knownTooLarge =
    kind === "text" && size != null && size > MAX_INLINE_TEXT_BYTES;

  // A draft kept from before an unmount brings back the content it was
  // made against, so the first read can tell a disk change from the edits.
  const [content, setContent] = useState<string | null>(
    () => drafts.get(tabId)?.base ?? null
  );
  const [body, setBody] = useState<Body>(
    knownTooLarge
      ? { state: "too-large" }
      : kind === "text"
      ? { state: "loading" }
      : { state: "ready" }
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Newer disk content held back because there are unsaved edits.
  const [diskChange, setDiskChange] = useState<string | null>(null);
  const [editing, setEditing] = useState(() => drafts.get(tabId) !== undefined);
  const [draft, setDraftText] = useState(() => drafts.get(tabId)?.text ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Cache-buster for showing an image or PDF again.
  const [version, setVersion] = useState(0);

  // Suppress updates after unmount — closing the inspector mid save/delete
  // unmounts the view while a request is still in flight.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dirty = editing && content !== null && draft !== content;
  useEffect(() => {
    onDirtyChange(tabId, dirty);
  }, [tabId, dirty, onDirtyChange]);

  // Store the edits with what they are against, in case the view unmounts.
  useEffect(() => {
    if (editing && content !== null) {
      drafts.set(tabId, { text: draft, base: content });
    }
  }, [editing, content, draft, drafts, tabId]);

  // Latest values for reads, which finish after the render that started them.
  const latest = useRef({ content, editing, draft, saving, body, version });
  useEffect(() => {
    latest.current = { content, editing, draft, saving, body, version };
  });
  const readIdRef = useRef(0);

  const read = useCallback(
    async (reason: "initial" | "auto" | "manual") => {
      if (kind !== "text") {
        // An image is re-shown on any refresh; a PDF only on request, since
        // reloading it jumps back to page one.
        if (reason === "manual" || (reason === "auto" && kind === "image")) {
          setVersion((v) => v + 1);
          setBody({ state: "ready" });
        }
        return;
      }
      if (knownTooLarge || latest.current.body.state === "too-large") return;
      // A save in flight decides the content; don't race it.
      if (reason === "auto" && latest.current.saving) return;
      const id = ++readIdRef.current;
      const current = () => mountedRef.current && id === readIdRef.current;
      try {
        const text = await readText(path);
        if (!current()) return;
        setRefreshError(null);
        setBody({ state: "ready" });
        const {
          content: shown,
          editing: isEditing,
          draft: edits,
        } = latest.current;
        if (shown === null) {
          setContent(text);
          return;
        }
        if (text === shown) {
          setDiskChange(null);
          return;
        }
        if (isEditing && edits !== shown) {
          setDiskChange(text);
          return;
        }
        setContent(text);
        setDiskChange(null);
        if (isEditing) setDraftText(text);
      } catch (e) {
        if (!current()) return;
        if (e instanceof TooLarge) {
          setBody({ state: "too-large" });
          return;
        }
        const message = e instanceof Error ? e.message : "Failed to load file.";
        const exists = await workspaceFileExists(path);
        if (!current()) return;
        const {
          content: shown,
          editing: isEditing,
          draft: edits,
        } = latest.current;
        const unsaved = isEditing && shown !== null && edits !== shown;
        if (exists === false && !unsaved) {
          setBody({ state: "missing" });
        } else if (exists === false) {
          setRefreshError("This file no longer exists on disk.");
        } else if (shown === null) {
          setBody({ state: "error", message });
        } else {
          setRefreshError(message);
        }
      }
    },
    [kind, knownTooLarge, path]
  );

  useEffect(() => {
    void read("initial");
  }, [read]);
  const autoRefresh = useCallback(() => void read("auto"), [read]);
  useTickRefresh(visible, refreshTick, autoRefresh);

  // A failed image load may be a passing hiccup (the figure being rewritten,
  // a backend restart): only the folder listing can say it's gone.
  const imageFailed = async () => {
    const failed = version;
    const exists = await workspaceFileExists(path);
    if (!mountedRef.current || latest.current.version !== failed) return;
    setBody(
      exists === false
        ? { state: "missing" }
        : { state: "error", message: "Failed to load image." }
    );
  };

  const finishEditing = () => {
    setEditing(false);
    setDiskChange(null);
    drafts.set(tabId, undefined);
  };
  const startEdit = () => {
    setDraftText(content ?? "");
    setActionError(null);
    setEditing(true);
  };

  const save = async () => {
    // A read already in flight saw the file before this save: drop it.
    readIdRef.current += 1;
    setSaving(true);
    setActionError(null);
    try {
      const res = await fetch(workspaceFileUrl(path), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to save.");
      drafts.set(tabId, undefined);
      onTreeChanged();
      if (!mountedRef.current) return;
      setContent(draft);
      finishEditing();
    } catch (e) {
      if (mountedRef.current) {
        setActionError(e instanceof Error ? e.message : "Failed to save.");
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      const res = await fetch(workspaceFileUrl(path), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to delete.");
      }
      drafts.set(tabId, undefined);
      onTreeChanged();
      onClose(tabId);
    } catch (e) {
      if (mountedRef.current) {
        // Close the confirm so the error isn't hidden behind it.
        setDeleteOpen(false);
        setActionError(e instanceof Error ? e.message : "Failed to delete.");
      }
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  };

  const downloadLink = (label: string) => (
    <a
      href={workspaceFileUrl(path, { download: true })}
      download={name}
    >
      <Download
        size={16}
        className="mr-1"
        aria-hidden="true"
      />
      {label}
    </a>
  );

  const renderBody = () => {
    if (editing) {
      return (
        <textarea
          value={draft}
          onChange={(e) => setDraftText(e.target.value)}
          spellCheck={false}
          aria-label="File content"
          className="h-full w-full resize-none rounded-md border border-border bg-background p-4 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          placeholder="File is empty…"
        />
      );
    }
    if (body.state === "missing") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            This file no longer exists.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onClose(tabId)}
          >
            Close tab
          </Button>
        </div>
      );
    }
    if (body.state === "error") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-12">
          <p className="text-sm text-destructive">{body.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void read("manual")}
          >
            Retry
          </Button>
        </div>
      );
    }
    if (kind === "image") {
      return (
        <ScrollArea className="h-full rounded-md bg-[var(--color-surface)]">
          <div className="flex items-center justify-center p-4">
            <img
              src={workspaceFileUrl(path, { version })}
              alt={name}
              onError={() => void imageFailed()}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </ScrollArea>
      );
    }
    if (kind === "pdf") {
      return (
        <iframe
          src={workspaceFileUrl(path, { version })}
          title={name}
          className="h-full w-full rounded-md border border-border"
        />
      );
    }
    if (kind === "binary" || body.state === "too-large") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {body.state === "too-large"
              ? "This file is too large to preview inline."
              : "This file type can't be previewed."}
          </p>
          <Button
            variant="outline"
            size="sm"
            asChild
          >
            {downloadLink("Download file")}
          </Button>
        </div>
      );
    }
    if (body.state === "loading") {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2
            className="size-5 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        </div>
      );
    }
    return (
      <ScrollArea className="h-full rounded-md bg-[var(--color-surface)]">
        <div className="p-4">
          <FileTextContent
            content={content ?? ""}
            ext={ext}
          />
        </div>
      </ScrollArea>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={path}
        >
          {path}
        </p>
        <div className={TOOLBAR}>
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => (dirty ? setDiscardOpen(true) : finishEditing())}
                disabled={saving}
              >
                <Eye
                  size={16}
                  className="mr-1"
                  aria-hidden="true"
                />
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-8 bg-[var(--brand-solid)] px-3 text-[var(--brand-foreground)] hover:opacity-90"
                onClick={save}
                disabled={saving || !dirty}
              >
                {saving ? (
                  <Loader2
                    size={16}
                    className="mr-1 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Save
                    size={16}
                    className="mr-1"
                    aria-hidden="true"
                  />
                )}
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => void read("manual")}
                aria-label="Reload file"
                title="Reload file"
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                />
              </Button>
              {kind === "text" &&
                body.state === "ready" &&
                content !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    onClick={startEdit}
                    aria-label="Edit file"
                  >
                    <Pencil
                      size={16}
                      className="mr-1"
                      aria-hidden="true"
                    />
                    Edit
                  </Button>
                )}
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                asChild
              >
                {downloadLink("Download")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                disabled={deleting}
                aria-label="Delete file"
                title="Delete file"
              >
                {deleting ? (
                  <Loader2
                    size={16}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2
                    size={16}
                    aria-hidden="true"
                  />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      {diskChange !== null && (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <span>The file changed on disk.</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => {
              setContent(diskChange);
              finishEditing();
            }}
          >
            Reload
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={() => {
              setContent(diskChange);
              setDiskChange(null);
            }}
          >
            Keep my edits
          </Button>
        </div>
      )}
      {refreshError && (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 text-sm text-destructive"
        >
          <span>{refreshError}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => void read("manual")}
          >
            Retry
          </Button>
        </div>
      )}
      {actionError && (
        <p
          role="alert"
          className="mb-2 text-sm text-destructive"
        >
          {actionError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">{renderBody()}</div>

      <Dialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your edits to “{name}” have not been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDiscardOpen(false)}
            >
              Keep Editing
            </Button>
            <Button
              onClick={() => {
                setDiscardOpen(false);
                finishEditing();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete file?</DialogTitle>
            <DialogDescription>
              “{name}” will be permanently removed from the workspace. This
              can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              onClick={remove}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
