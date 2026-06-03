"use client";

import React, { useMemo, useState, useEffect } from "react";
import { Download, Loader2, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownContent } from "@/app/components/MarkdownContent";

const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  cpp: "cpp",
  c: "c",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  jsonl: "json",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  tex: "latex",
  bib: "latex",
  r: "r",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
// Extensions we render as text. Anything not here and not an image/pdf is
// treated as a binary download.
const TEXT_EXTS = new Set([
  ...Object.keys(LANGUAGE_MAP),
  "txt",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "cfg",
  "conf",
  "env",
  "gitignore",
]);
// Inline text preview is capped — bigger files are offered as a download so we
// never pull tens of MB into the browser just to render it.
const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;

export function workspaceFileUrl(path: string, download = false): string {
  const qs = new URLSearchParams({ path });
  if (download) qs.set("download", "1");
  return `/api/workspace/file?${qs.toString()}`;
}

type Kind = "text" | "image" | "pdf" | "binary";

function kindOf(ext: string): Kind {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

export const WorkspaceFileDialog = React.memo<{
  /** Path relative to the workspace root, or null to close. */
  path: string | null;
  /** Byte size from the listing — used to gate inline text preview. */
  size?: number;
  onClose: () => void;
}>(({ path, size, onClose }) => {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = path ? path.split("/").pop() || path : "";
  const ext = useMemo(
    () => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""),
    [name]
  );
  const kind = kindOf(ext);
  const tooBigForText =
    kind === "text" && size != null && size > MAX_INLINE_TEXT_BYTES;

  useEffect(() => {
    if (!path || kind !== "text" || tooBigForText) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(workspaceFileUrl(path))
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `Failed to load file (${res.status})`);
        }
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load file.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, kind, tooBigForText]);

  if (!path) return null;

  const isMarkdown = ext === "md" || ext === "markdown";
  const language = LANGUAGE_MAP[ext] || "text";

  return (
    <Dialog
      open={true}
      onOpenChange={onClose}
    >
      <DialogContent className="flex h-[80vh] max-h-[80vh] min-w-[60vw] flex-col p-6">
        <DialogTitle className="sr-only">{path}</DialogTitle>
        <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-5 w-5 shrink-0 text-[var(--color-text-tertiary)]" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-base font-medium text-primary">
              {path}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={workspaceFileUrl(path, true)}
              download={name}
            >
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                asChild
              >
                <span>
                  <Download
                    size={16}
                    className="mr-1"
                  />
                  Download
                </span>
              </Button>
            </a>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {kind === "image" ? (
            <ScrollArea className="bg-surface h-full rounded-md">
              <div className="flex items-center justify-center p-4">
                <img
                  src={workspaceFileUrl(path)}
                  alt={name}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </ScrollArea>
          ) : kind === "pdf" ? (
            <iframe
              src={workspaceFileUrl(path)}
              title={name}
              className="h-full w-full rounded-md border border-border"
            />
          ) : kind === "binary" || tooBigForText ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
              <p className="text-sm text-muted-foreground">
                {tooBigForText
                  ? "This file is too large to preview inline."
                  : "This file type can't be previewed."}
              </p>
              <a
                href={workspaceFileUrl(path, true)}
                download={name}
              >
                <Button
                  variant="outline"
                  size="sm"
                >
                  <Download
                    size={16}
                    className="mr-1"
                  />
                  Download file
                </Button>
              </a>
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-12">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : (
            <ScrollArea className="bg-surface h-full rounded-md">
              <div className="p-4">
                {content && content.length > 0 ? (
                  isMarkdown ? (
                    <div className="rounded-md p-6">
                      <MarkdownContent content={content} />
                    </div>
                  ) : (
                    <SyntaxHighlighter
                      language={language}
                      style={oneDark}
                      customStyle={{
                        margin: 0,
                        borderRadius: "0.5rem",
                        fontSize: "0.875rem",
                      }}
                      showLineNumbers
                      wrapLines={true}
                      lineProps={{ style: { whiteSpace: "pre-wrap" } }}
                    >
                      {content}
                    </SyntaxHighlighter>
                  )
                ) : (
                  <div className="flex items-center justify-center p-12">
                    <p className="text-sm text-muted-foreground">
                      File is empty
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});

WorkspaceFileDialog.displayName = "WorkspaceFileDialog";
