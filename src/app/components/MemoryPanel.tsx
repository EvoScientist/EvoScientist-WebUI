"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  BrainCircuit,
  Check,
  Copy,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Save,
  Trash2,
} from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MarkdownContent } from "@/app/components/MarkdownContent";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";

interface MemoryEntry {
  path: string;
  size: number;
  mtime: number;
  editable: boolean;
}

interface MemoryListing {
  dir: string;
  exists: boolean;
  entries: MemoryEntry[];
  truncated: boolean;
}

interface MemoryFile {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

const LANGUAGE_MAP: Record<string, string> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  csv: "text",
  tsv: "text",
  log: "text",
  txt: "text",
  tex: "latex",
  bib: "latex",
  rst: "markdown",
};

// Friendly, ordered groups derived from a memory file's relative path.
const GROUP_ORDER = [
  "Core memory",
  "Profile",
  "Projects",
  "Evolution reports",
] as const;

function groupOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "profile") {
    return parts[1] === "projects" ? "Projects" : "Profile";
  }
  if (parts[0] === "evolution-reports") return "Evolution reports";
  if (parts.length === 1) return "Core memory";
  return parts[0];
}

/** A short subtitle shown under the file name (the containing dir, if any). */
function subPathOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

function fileNameOf(path: string): string {
  return path.split("/").pop() || path;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

const MEMORY_LIST_MIN_WIDTH = 200;
const MEMORY_LIST_DEFAULT_WIDTH = 256; // matches the old fixed `md:w-64`
const MEMORY_LIST_WIDTH_KEY = "evoscientist-memory-list-width";

/** Clamp the list width to [min, container − 360] so the viewer always has room.
 *  Falls back to a fixed cap when the container isn't measured yet. */
function clampListWidth(w: number, container: HTMLElement | null): number {
  const max = container
    ? Math.max(MEMORY_LIST_MIN_WIDTH + 80, container.clientWidth - 360)
    : 640;
  return Math.min(Math.max(w, MEMORY_LIST_MIN_WIDTH), max);
}

/** True on md+ viewports (matches Tailwind's `md:` breakpoint = 768px). Starts
 *  false (SSR-safe) and corrects on mount. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

export function MemoryPanel() {
  const [listing, setListing] = useState<MemoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<MemoryFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const didAutoSelect = useRef(false);
  // Monotonic id so a slow file fetch can't overwrite a newer selection.
  const reqRef = useRef(0);

  // --- Resizable file-list / viewer split (desktop only) -------------------
  const isDesktop = useIsDesktop();
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [listWidth, setListWidth] = useState<number>(() => {
    if (typeof window === "undefined") return MEMORY_LIST_DEFAULT_WIDTH;
    const saved = Number(window.localStorage.getItem(MEMORY_LIST_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MEMORY_LIST_MIN_WIDTH
      ? saved
      : MEMORY_LIST_DEFAULT_WIDTH;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(MEMORY_LIST_WIDTH_KEY, String(listWidth));
    } catch {
      // localStorage unavailable (e.g. private mode) — width just won't persist.
    }
  }, [listWidth]);
  // Callback ref for the split container: attach a ResizeObserver the moment it
  // mounts (the list renders only after data loads, so a plain effect could run
  // before the node exists). The observer fires once on observe — clamping a
  // persisted width too wide for the current window — and again on every resize.
  // Desktop-only (the width isn't applied on mobile); disconnects on unmount.
  const setSplitContainer = useCallback((node: HTMLDivElement | null) => {
    splitContainerRef.current = node;
    roRef.current?.disconnect();
    roRef.current = null;
    if (node && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (window.matchMedia("(min-width: 768px)").matches) {
          setListWidth((w) => clampListWidth(w, node));
        }
      });
      ro.observe(node);
      roRef.current = ro;
    }
  }, []);
  // Tear down an in-progress drag if the component unmounts mid-drag.
  useEffect(() => () => dragCleanupRef.current?.(), []);
  const onDividerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragCleanupRef.current?.(); // defensive: end any stray prior drag
      const startX = e.clientX;
      const startW = listWidth;
      const controller = new AbortController();
      const cleanup = () => {
        controller.abort(); // removes every listener added with this signal
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        dragCleanupRef.current = null;
      };
      const move = (ev: PointerEvent) => {
        setListWidth(
          clampListWidth(
            startW + (ev.clientX - startX),
            splitContainerRef.current
          )
        );
      };
      const opts = { signal: controller.signal };
      // Track on window so the drag continues even if the pointer leaves the thin
      // handle; pointercancel / blur also end it so the global cursor + selection
      // lock and the listeners never get stuck.
      window.addEventListener("pointermove", move, opts);
      window.addEventListener("pointerup", cleanup, opts);
      window.addEventListener("pointercancel", cleanup, opts);
      window.addEventListener("blur", cleanup, opts);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      dragCleanupRef.current = cleanup;
    },
    [listWidth]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/memory");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load memory.");
      setListing(data as MemoryListing);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Group + sort the file list for the sidebar.
  const groups = useMemo(() => {
    const entries = listing?.entries ?? [];
    const byGroup = new Map<string, MemoryEntry[]>();
    for (const e of entries) {
      const g = groupOf(e.path);
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(e);
    }
    const names = [...byGroup.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a as (typeof GROUP_ORDER)[number]);
      const ib = GROUP_ORDER.indexOf(b as (typeof GROUP_ORDER)[number]);
      if (ia !== -1 || ib !== -1) {
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      }
      return a.localeCompare(b);
    });
    return names.map((name) => ({
      name,
      files: byGroup.get(name)!.sort((a, b) => a.path.localeCompare(b.path)),
    }));
  }, [listing]);

  const openFile = useCallback(async (path: string) => {
    const reqId = ++reqRef.current;
    setSelected(path);
    setEditing(false);
    setFile(null);
    setFileError(null);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/memory?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      // A newer openFile started while this was in flight — drop the stale result.
      if (reqId !== reqRef.current) return;
      if (!res.ok) throw new Error(data.error || "Failed to open file.");
      setFile(data as MemoryFile);
    } catch (e) {
      if (reqId !== reqRef.current) return;
      setFileError(e instanceof Error ? e.message : "Failed to open file.");
    } finally {
      if (reqId === reqRef.current) setFileLoading(false);
    }
  }, []);

  // Auto-open the first file once, so the panel isn't empty on first view.
  useEffect(() => {
    if (didAutoSelect.current || selected) return;
    const first = groups[0]?.files[0];
    if (first) {
      didAutoSelect.current = true;
      openFile(first.path);
    }
  }, [groups, selected, openFile]);

  const startEdit = () => {
    if (!file) return;
    setDraft(file.content);
    setEditing(true);
  };

  const save = async () => {
    if (!selected) return;
    const reqId = reqRef.current; // detect a file switch during the await
    setSaving(true);
    setFileError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected, content: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save.");
      // If the user switched files mid-save, don't clobber the now-current
      // file's view (the save itself still persisted to disk).
      if (reqId === reqRef.current) {
        setFile(data as MemoryFile);
        setEditing(false);
      }
      // Reflect the new size/mtime in the list.
      load();
    } catch (e) {
      if (reqId === reqRef.current) {
        setFileError(e instanceof Error ? e.message : "Failed to save.");
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!selected) return;
    const reqId = reqRef.current; // detect a file switch during the await
    setDeleteBusy(true);
    try {
      const res = await fetch(
        `/api/memory?path=${encodeURIComponent(selected)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Failed to delete.");
      }
      // Only reset the view if the user is still on the file they deleted.
      if (reqId === reqRef.current) {
        setSelected(null);
        setFile(null);
        setEditing(false);
      }
      setDeleteOpen(false);
      load();
    } catch (e) {
      if (reqId === reqRef.current) {
        setFileError(e instanceof Error ? e.message : "Failed to delete.");
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  const copy = async () => {
    if (!file) return;
    if (await copyText(file.content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const createNew = async () => {
    let name = newName.trim();
    if (!name) {
      setNewError("Enter a file name.");
      return;
    }
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += ".md";
    setNewBusy(true);
    setNewError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: name,
          content: `# ${fileNameOf(name).replace(/\.[^.]+$/, "")}\n\n`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create file.");
      setNewOpen(false);
      setNewName("");
      await load();
      await openFile((data as MemoryFile).path);
      setDraft((data as MemoryFile).content);
      setEditing(true);
    } catch (e) {
      setNewError(e instanceof Error ? e.message : "Failed to create file.");
    } finally {
      setNewBusy(false);
    }
  };

  // Unsaved-edit guard: confirm before navigating away from dirty edits.
  const dirty = editing && file != null && draft !== file.content;
  const confirmDiscard = () =>
    !dirty || window.confirm("Discard your unsaved changes?");

  const ext = selected ? extOf(fileNameOf(selected)) : "";
  const isMarkdown = ext === "md" || ext === "markdown";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BrainCircuit
              className="size-5 text-[var(--brand)]"
              aria-hidden="true"
            />
            <h2 className="text-xl font-semibold">Memory</h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            EvoScientist&apos;s long-term memory — what it knows about you, your
            research taste, and lessons from past work. View or edit it
            directly.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setNewName("");
              setNewError(null);
              setNewOpen(true);
            }}
            aria-label="New memory file"
            title="New memory file"
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-solid)] px-2.5 py-1.5 text-xs font-medium text-[var(--brand-foreground)] transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus
              className="size-3.5"
              aria-hidden="true"
            />
            <span className="hidden sm:inline">New</span>
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw
              className={loading ? "size-4 animate-spin" : "size-4"}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>

      {error ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : loading && !listing ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2
            className="size-4 animate-spin"
            aria-hidden="true"
          />
          Loading memory…
        </div>
      ) : listing && !listing.exists ? (
        <EmptyAll dir={listing.dir} />
      ) : listing && listing.entries.length === 0 ? (
        <EmptyAll dir={listing.dir} />
      ) : (
        <div
          ref={setSplitContainer}
          className="flex min-h-0 flex-1"
        >
          {/* File list */}
          <aside
            className={cn(
              "w-full flex-col md:flex md:flex-shrink-0",
              selected ? "hidden md:flex" : "flex"
            )}
            style={isDesktop ? { width: listWidth } : undefined}
          >
            <ScrollArea className="h-0 flex-1">
              <div className="p-1.5">
                {groups.map((group) => (
                  <div
                    key={group.name}
                    className="mb-2.5"
                  >
                    <h4 className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.name}
                    </h4>
                    <div className="flex flex-col">
                      {group.files.map((entry) => {
                        const sub = subPathOf(entry.path);
                        const active = entry.path === selected;
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => {
                              if (confirmDiscard()) openFile(entry.path);
                            }}
                            className={cn(
                              "flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                              active ? "bg-accent" : "hover:bg-accent/60"
                            )}
                            aria-current={active}
                          >
                            <FileText
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {fileNameOf(entry.path)}
                              </span>
                              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                                {sub && <span className="truncate">{sub}</span>}
                                <span className="shrink-0 tabular-nums">
                                  {formatBytes(entry.size)}
                                </span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {listing?.truncated && (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    Showing the first {listing.entries.length} files.
                  </p>
                )}
              </div>
            </ScrollArea>
          </aside>

          {/* Draggable divider between list and viewer (desktop only). */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file list"
            onPointerDown={onDividerPointerDown}
            className="relative hidden w-px shrink-0 cursor-col-resize bg-border transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 hover:bg-[var(--brand)] md:block"
          />

          {/* Viewer / editor */}
          <section
            className={cn(
              "min-w-0 flex-1 flex-col",
              selected ? "flex" : "hidden md:flex"
            )}
          >
            {!selected ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <p className="text-sm text-muted-foreground">
                  Select a memory file to view or edit.
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirmDiscard()) return;
                      setSelected(null);
                      setFile(null);
                      setEditing(false);
                    }}
                    aria-label="Back to list"
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                  >
                    <ArrowLeft
                      className="size-4"
                      aria-hidden="true"
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {fileNameOf(selected)}
                    </p>
                    {file && (
                      <p className="truncate text-xs text-muted-foreground">
                        {subPathOf(selected) && `${subPathOf(selected)} · `}
                        {formatBytes(file.size)}
                        {file.mtime ? ` · ${formatTime(file.mtime)}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!editing ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={copy}
                          disabled={!file}
                          aria-label={
                            copied
                              ? "Copied memory content"
                              : "Copy memory content"
                          }
                          title={
                            copied
                              ? "Copied memory content"
                              : "Copy memory content"
                          }
                        >
                          {copied ? (
                            <Check className="size-4" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={startEdit}
                          disabled={!file}
                          aria-label="Edit memory file"
                        >
                          <Pencil className="mr-1 size-4" />
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteOpen(true)}
                          disabled={!file}
                          aria-label="Delete memory file"
                          title="Delete memory file"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => {
                            if (confirmDiscard()) setEditing(false);
                          }}
                          disabled={saving}
                          aria-label="Cancel editing"
                        >
                          <Eye className="mr-1 size-4" />
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 px-3"
                          onClick={save}
                          disabled={saving || !dirty}
                          aria-label="Save memory file"
                        >
                          {saving ? (
                            <Loader2 className="mr-1 size-4 animate-spin" />
                          ) : (
                            <Save className="mr-1 size-4" />
                          )}
                          {saving ? "Saving…" : "Save"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {fileError && (
                  <p
                    role="alert"
                    className="px-4 py-2 text-sm text-destructive"
                  >
                    {fileError}
                  </p>
                )}

                <div className="min-h-0 flex-1 overflow-hidden">
                  {fileLoading ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : editing ? (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      spellCheck={false}
                      aria-label="Memory file content"
                      className="h-full w-full resize-none bg-background p-4 font-mono text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      placeholder="Write memory…"
                    />
                  ) : file ? (
                    <ScrollArea className="h-full">
                      <div className="mx-auto max-w-[780px] px-4 py-4 sm:px-6">
                        {file.content.trim().length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            This file is empty.
                          </p>
                        ) : isMarkdown ? (
                          <MarkdownContent content={file.content} />
                        ) : (
                          <SyntaxHighlighter
                            language={LANGUAGE_MAP[ext] || "text"}
                            style={oneDark}
                            customStyle={{
                              margin: 0,
                              borderRadius: "0.5rem",
                              fontSize: "0.85rem",
                            }}
                            wrapLongLines
                          >
                            {file.content}
                          </SyntaxHighlighter>
                        )}
                      </div>
                    </ScrollArea>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* New memory dialog */}
      <Dialog
        open={newOpen}
        onOpenChange={(open) => {
          if (!newBusy) setNewOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New memory file</DialogTitle>
            <DialogDescription>
              Create a markdown file in the memory directory. Use a path like{" "}
              <code className="font-mono text-xs">notes/idea.md</code> to nest
              it.
            </DialogDescription>
          </DialogHeader>
          <Input
            name="memory-file-path"
            autoComplete="off"
            spellCheck={false}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                createNew();
              }
            }}
            placeholder="notes/research-idea.md…"
            disabled={newBusy}
            aria-invalid={newError ? true : undefined}
            aria-describedby={newError ? "new-memory-error" : undefined}
          />
          {newError && (
            <p
              id="new-memory-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {newError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewOpen(false)}
              disabled={newBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={createNew}
              disabled={newBusy || !newName.trim()}
            >
              {newBusy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleteBusy) setDeleteOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete memory file?</DialogTitle>
            <DialogDescription>
              {selected ? (
                <>
                  <code>{selected}</code> will be permanently deleted. This
                  can&apos;t be undone.
                </>
              ) : (
                "This memory file will be permanently deleted."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deleteBusy || !selected}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyAll({ dir }: { dir: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <BrainCircuit
        className="size-10 text-muted-foreground/40"
        aria-hidden="true"
      />
      <p className="text-sm font-medium">No memory yet</p>
      <p className="max-w-md text-sm text-muted-foreground">
        EvoScientist will write what it learns here as you work together. Memory
        lives at <code className="break-all font-mono text-xs">{dir}</code>.
      </p>
    </div>
  );
}
