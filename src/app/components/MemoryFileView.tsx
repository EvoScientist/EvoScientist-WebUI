"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTextContent } from "@/app/components/FileTextContent";
import { useTickRefresh } from "@/app/hooks/useTickRefresh";
import { memoryFileExists } from "@/lib/fileExistence";
import { extOf, fileNameOf } from "@/lib/fileKinds";

export interface MemoryFileViewProps {
  tabId: string;
  /** Path under the memory root, e.g. `notes/day1.md`. */
  path: string;
  visible: boolean;
  refreshTick: number;
  onClose: (tabId: string) => void;
}

async function readMemory(path: string): Promise<string> {
  const res = await fetch(`/api/memory?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { content?: unknown };
  return typeof data.content === "string" ? data.content : "";
}

/**
 * A memory file, read-only (the Memory view has the editor). Follows rewrites
 * by the background memory worker like the workspace view follows the agent.
 */
export function MemoryFileView({
  tabId,
  path,
  visible,
  refreshTick,
  onClose,
}: MemoryFileViewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const id = ++readIdRef.current;
    const current = () => mountedRef.current && id === readIdRef.current;
    try {
      const text = await readMemory(path);
      if (!current()) return;
      setContent(text);
      setMissing(false);
      setError(null);
    } catch (e) {
      if (!current()) return;
      const exists = await memoryFileExists(path);
      if (!current()) return;
      if (exists === false) setMissing(true);
      else setError(e instanceof Error ? e.message : "Failed to read file.");
    }
  }, [path]);

  useEffect(() => {
    void read();
  }, [read]);
  useTickRefresh(visible, refreshTick, read);

  const ext = extOf(fileNameOf(path));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <p
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          title={`/memories/${path}`}
        >
          /memories/{path}
        </p>
        <div className="flex shrink-0 items-center gap-1 max-sm:[&>button]:min-h-11 max-sm:[&>button]:min-w-11">
          <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            Read-only
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            onClick={() => void read()}
            aria-label="Reload file"
            title="Reload file"
          >
            <RefreshCw
              size={16}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
      {error && content !== null && (
        <p
          role="alert"
          className="mb-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {missing ? (
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
        ) : content === null ? (
          <div className="flex h-full items-center justify-center">
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : (
              <Loader2
                className="size-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </div>
        ) : (
          <ScrollArea className="h-full rounded-md bg-[var(--color-surface)]">
            <div className="p-4">
              <FileTextContent
                content={content}
                ext={ext}
              />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
