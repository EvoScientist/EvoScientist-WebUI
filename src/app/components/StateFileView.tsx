"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Copy, Download, Eye, Loader2, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTextContent } from "@/app/components/FileTextContent";
import { copyText } from "@/lib/clipboard";
import { extOf, fileNameOf } from "@/lib/fileKinds";
import { stateFileText } from "@/lib/stateFiles";
import type { ChatFilesBridge, DraftStore } from "@/providers/filePaneContext";

export interface StateFileViewProps {
  tabId: string;
  /** Key in the conversation's agent-state files. */
  path: string;
  chat: ChatFilesBridge | null;
  drafts: DraftStore;
  onDirtyChange: (tabId: string, dirty: boolean) => void;
  onClose: (tabId: string) => void;
}

/** An agent-state file of the open conversation; live with the chat stream. */
export function StateFileView({
  tabId,
  path,
  chat,
  drafts,
  onDirtyChange,
  onClose,
}: StateFileViewProps) {
  const live =
    chat && Object.prototype.hasOwnProperty.call(chat.files, path)
      ? stateFileText(chat.files[path])
      : null;
  // The chat's files aren't refetched after a save: show the saved text
  // until the conversation's copy of the file changes.
  const [saved, setSaved] = useState<{
    over: string | null;
    text: string;
  } | null>(null);
  const content = saved && saved.over === live ? saved.text : live;
  const [editing, setEditing] = useState(() => drafts.get(tabId) !== undefined);
  const [draft, setDraftText] = useState(() => drafts.get(tabId)?.text ?? "");
  const [saving, setSaving] = useState(false);

  const dirty = editing && content !== null && draft !== content;
  useEffect(() => {
    onDirtyChange(tabId, dirty);
  }, [tabId, dirty, onDirtyChange]);

  const updateDraft = (text: string) => {
    setDraftText(text);
    drafts.set(tabId, { text, base: content ?? "" });
  };
  const stopEditing = () => {
    setEditing(false);
    drafts.set(tabId, undefined);
  };

  const save = async () => {
    if (!chat) return;
    setSaving(true);
    try {
      await chat.setFiles({ ...chat.files, [path]: draft });
      setSaved({ over: live, text: draft });
      stopEditing();
    } catch (error) {
      toast.error(`Failed to save file: ${error}`);
    } finally {
      setSaving(false);
    }
  };

  const name = fileNameOf(path);
  const download = useCallback(() => {
    if (content === null) return;
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/plain" })
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [content, name]);

  if (!chat) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-center">
        <p className="text-sm text-muted-foreground">
          Open the conversation this file belongs to.
        </p>
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
        <p className="text-sm text-muted-foreground">
          This file is no longer in the conversation.
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <p
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={path}
        >
          {path}
        </p>
        <div className="flex shrink-0 items-center gap-1 max-sm:[&>button]:min-h-11 max-sm:[&>button]:min-w-11">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={stopEditing}
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
                Save
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => {
                  updateDraft(content);
                  setEditing(true);
                }}
                disabled={chat.editDisabled}
                aria-label="Edit file"
              >
                <Pencil
                  size={16}
                  className="mr-1"
                  aria-hidden="true"
                />
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => void copyText(content)}
                aria-label="Copy file"
              >
                <Copy
                  size={16}
                  aria-hidden="true"
                />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={download}
                aria-label="Download file"
              >
                <Download
                  size={16}
                  aria-hidden="true"
                />
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
            spellCheck={false}
            aria-label="File content"
            className="h-full w-full resize-none rounded-md border border-border bg-background p-4 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ) : (
          <ScrollArea className="h-full rounded-md bg-[var(--color-surface)]">
            <div className="p-4">
              <FileTextContent
                content={content}
                ext={extOf(name)}
              />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
