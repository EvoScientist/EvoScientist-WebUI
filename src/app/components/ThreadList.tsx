"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BrainCircuit,
  ChevronRight,
  Clock,
  Download,
  FolderMinus,
  FolderPlus,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Users,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useQueryState } from "nuqs";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatTime, formatFullTime } from "@/lib/time";
import type { ThreadItem } from "@/app/hooks/useThreads";
import {
  useThreads,
  deleteThread,
  renameThread,
  pinThread,
  exportThread,
} from "@/app/hooks/useThreads";
import { ThreadGroups } from "@/app/components/ThreadGroups";
import { useRevalidateOn } from "@/app/hooks/useRevalidateOn";
import { dedupeThreads, matchesSearch } from "@/lib/threadLists";
import { useProjects } from "@/providers/ProjectsProvider";
import { useProjectDialogs } from "@/providers/projectDialogsContext";
import type { Project } from "@/lib/projects";
import { folderName } from "@/lib/workspaceAssistant";
import { useMemoryActivity } from "@/app/hooks/useMemoryActivity";
import {
  getThreadAutoApprove,
  useAutoApproveRevision,
} from "@/lib/autoApprove";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type StatusFilter = "all" | "idle" | "busy" | "interrupted" | "error";

/** A page of the searches across projects (attention, busy). */
const ACROSS_PROJECTS_LIMIT = 100;
/** How many such pages Requiring Attention reads at most. */
const ATTENTION_PAGES = 5;
/** How often the searches across projects read again: runs in other
 *  projects, scheduled tasks and the CLI change them too. */
const ACROSS_PROJECTS_REFRESH_MS = 15_000;
/** Reloads asked for within this are done once. */
const RELOAD_BUNDLE_MS = 300;

const STATUS_COLORS: Record<ThreadItem["status"], string> = {
  idle: "bg-green-500",
  busy: "bg-blue-500",
  interrupted: "bg-orange-500",
  error: "bg-red-600",
};

const STATUS_LABELS: Record<ThreadItem["status"], string> = {
  idle: "Idle",
  busy: "Busy",
  interrupted: "Interrupted",
  error: "Error",
};

function getThreadColor(status: ThreadItem["status"]): string {
  return STATUS_COLORS[status] ?? "bg-gray-400";
}

function StatusFilterItem({
  status,
  label,
  badge,
}: {
  status: ThreadItem["status"];
  label: string;
  badge?: number;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          getThreadColor(status)
        )}
      />
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-1 inline-flex items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-bold leading-none text-white">
          {badge}
        </span>
      )}
    </span>
  );
}

interface ThreadListProps {
  onThreadSelect: (id: string) => void;
  onClose?: () => void;
  /** A new chat, in `project` when given, else in the current one. */
  onNewChat?: (project?: string) => void;
  onMutateReady?: (mutate: () => void) => void;
  onInterruptCountChange?: (count: number) => void;
}

export function ThreadList({
  onThreadSelect,
  onClose,
  onNewChat,
  onMutateReady,
  onInterruptCountChange,
}: ThreadListProps) {
  const [currentThreadId, setThreadId] = useQueryState("threadId");
  const [view, setView] = useQueryState("view");
  // Badge the Memory nav when long-term memory changed since last viewed.
  const { unseenCount: memoryUnseen, markSeen: markMemorySeen } =
    useMemoryActivity();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [renameTarget, setRenameTarget] = useState<ThreadItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ThreadItem | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [pinBusyIds, setPinBusyIds] = useState<Set<string>>(() => new Set());
  const [exportBusyIds, setExportBusyIds] = useState<Set<string>>(
    () => new Set()
  );

  const { projects, current } = useProjects();
  const { openAddProject, openRemoveProject } = useProjectDialogs();
  const projectList = useMemo(
    () => (projects.status === "ready" ? projects.projects : []),
    [projects]
  );
  const projectByKey = useMemo(
    () => new Map(projectList.map((project) => [project.key, project])),
    [projectList]
  );
  const ready = projects.status === "ready";

  // Every list reads again when this moves on (a run ended, a thread was
  // renamed, pinned or deleted). A run asks several times as it goes;
  // asks close together are done once.
  const [revision, setRevision] = useState(0);
  const reloadTimer = useRef<number | null>(null);
  const mutateFn = useCallback(() => {
    if (reloadTimer.current !== null) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      setRevision((r) => r + 1);
    }, RELOAD_BUNDLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    },
    []
  );
  const projectKeys = useMemo(
    () => projectList.map((project) => project.key),
    [projectList]
  );

  useEffect(() => {
    const tick = () => setNow(new Date());
    const interval = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // A thread belongs in "Requiring Attention" when its interrupt actually needs
  // the user. Single source of truth for both the section and the count badge.
  //   - `needsUserInput` (an `ask_user` interrupt is active) - auto-approve can
  //     NOT answer these, so the row must surface no matter what.
  //   - A plain tool-approval interrupt that will NOT be auto-resolved: either
  //     auto-approve is off (the user has to approve it), OR this is not the
  //     currently-open thread. The auto-resume effect lives only in the mounted
  //     ChatInterface (the open thread), so a backgrounded auto-approve thread
  //     that hits a tool-approval interrupt is NOT resumed on its own - it must
  //     keep surfacing here until the user opens it (which triggers the resume).
  // Only the open auto-approve thread is exempted: lifting it out of its time
  // group would make it jump around for a behaviour the user opted out of, and
  // it really will resume a moment later.
  const autoApproveRevision = useAutoApproveRevision();
  const needsAttention = useCallback(
    (thread: ThreadItem): boolean => {
      if (thread.needsUserInput) return true;
      if (thread.status !== "interrupted") return false;
      const willAutoResume =
        thread.id === currentThreadId && getThreadAutoApprove(thread.id);
      return !willAutoResume;
    },
    // `autoApproveRevision` re-buckets the rows when the toggle flips; the
    // setting lives in localStorage, which React cannot see change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentThreadId, autoApproveRevision]
  );

  // "Requiring Attention" spans every project, from one search: a question
  // waiting in a collapsed project shows by name, and the badge counts it.
  // Only registered projects' threads: another folder's can't run here.
  const interruptedThreads = useThreads({
    scope: ready ? { projects: projectKeys } : null,
    status: "interrupted",
    limit: ACROSS_PROJECTS_LIMIT,
    refreshInterval: ACROSS_PROJECTS_REFRESH_MS,
  });
  useRevalidateOn(revision, interruptedThreads.mutate);
  // Every page, up to a bound: the badge counts what waits.
  const attentionMore =
    interruptedThreads.data?.at(-1)?.full === true &&
    interruptedThreads.data.length === interruptedThreads.size &&
    interruptedThreads.size < ATTENTION_PAGES;
  const { size: attentionSize, setSize: setAttentionSize } = interruptedThreads;
  useEffect(() => {
    if (attentionMore) void setAttentionSize(attentionSize + 1);
  }, [attentionMore, attentionSize, setAttentionSize]);
  const attention = useMemo(
    () => dedupeThreads(interruptedThreads.data).filter(needsAttention),
    [interruptedThreads.data, needsAttention]
  );
  const waitingByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of attention) {
      if (t.workspaceDir) {
        counts.set(t.workspaceDir, (counts.get(t.workspaceDir) ?? 0) + 1);
      }
    }
    return counts;
  }, [attention]);
  const attentionIds = useMemo(
    () => new Set(attention.map((t) => t.id)),
    [attention]
  );
  const interruptedCount = attention.length;
  const showAttention =
    statusFilter === "all" || statusFilter === "interrupted";
  const attentionShown = showAttention
    ? attention.filter((t) => matchesSearch(t, search))
    : [];

  // Projects with a running conversation, for the marker on their rows.
  const busyThreads = useThreads({
    scope: ready ? { projects: projectKeys } : null,
    status: "busy",
    limit: ACROSS_PROJECTS_LIMIT,
    labels: false,
    refreshInterval: ACROSS_PROJECTS_REFRESH_MS,
  });
  useRevalidateOn(revision, busyThreads.mutate);
  const busyProjects = useMemo(
    () =>
      new Set(
        dedupeThreads(busyThreads.data).flatMap((t) =>
          t.workspaceDir ? [t.workspaceDir] : []
        )
      ),
    [busyThreads.data]
  );

  // Open sections: the current project opens by itself, the others when
  // the user opens them; a closed section reads nothing.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const currentKey = current?.key ?? null;
  useEffect(() => {
    if (!currentKey) return;
    setOpen((prev) =>
      prev.has(currentKey) ? prev : new Set(prev).add(currentKey)
    );
  }, [currentKey]);
  const toggleSection = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const statusParam = statusFilter === "all" ? undefined : statusFilter;

  // Expose thread list revalidation to the parent.
  const onMutateReadyRef = useRef(onMutateReady);
  useEffect(() => {
    onMutateReadyRef.current = onMutateReady;
  }, [onMutateReady]);
  useEffect(() => {
    onMutateReadyRef.current?.(mutateFn);
    // Only run once on mount to avoid infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notify parent of interrupt count changes
  useEffect(() => {
    onInterruptCountChange?.(interruptedCount);
  }, [interruptedCount, onInterruptCountChange]);

  // Synchronous re-entry lock: `actionBusy` state only blocks after a re-render,
  // so a fast second Enter could fire a mutation twice. The ref guards instantly.
  const actionBusyRef = useRef(false);
  const pinBusyIdsRef = useRef<Set<string>>(new Set());
  const exportBusyIdsRef = useRef<Set<string>>(new Set());

  // After deleting a thread its row (and the trigger button) is gone, so move
  // keyboard focus to a stable target (New Chat) instead of dropping to <body>.
  const newChatRef = useRef<HTMLButtonElement>(null);
  const pendingDeleteFocusRef = useRef(false);
  // A dialog opened from the "⋯" menu has no opener left to return focus to —
  // the menu item unmounts with the menu — so remember the row and hand focus
  // back to its trigger. Looked up by id at close time: a rename re-renders the
  // list. Dialogs opened from the desktop toolbar keep Radix's own restore.
  const menuOriginRef = useRef<string | null>(null);
  const restoreMenuFocus = (e: Event) => {
    const threadId = menuOriginRef.current;
    menuOriginRef.current = null;
    if (threadId === null) return;
    const trigger = Array.from(
      document.querySelectorAll<HTMLElement>("[data-thread-actions]")
    ).find((el) => el.dataset.threadActions === threadId);
    if (!trigger) return;
    // Hidden at desktop widths, and the viewport can grow while a dialog is open
    // (a rotated phone). Radix's default would not help — what it remembers is
    // the unmounted menu item — so fall back to the row's select button.
    const target =
      getComputedStyle(trigger).display === "none"
        ? trigger.parentElement?.querySelector<HTMLElement>("button")
        : trigger;
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  const submitRename = async () => {
    if (!renameTarget || actionBusyRef.current) return;
    const title = renameValue.trim();
    if (!title || title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    actionBusyRef.current = true;
    setActionBusy(true);
    try {
      await renameThread(renameTarget.id, title);
      setRenameTarget(null);
      mutateFn();
    } catch {
      toast.error("Couldn't rename — try again.");
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    try {
      await deleteThread(deleteTarget.id);
      // If the open thread was deleted, take the SAME reset path as New Chat
      // (which also remounts the chat session) instead of only clearing URL state.
      if (currentThreadId === deleteTarget.id) {
        if (onNewChat) {
          onNewChat();
        } else {
          setThreadId(null);
          setView(null);
        }
      }
      // Hand focus to New Chat once the dialog closes (the trigger is gone).
      pendingDeleteFocusRef.current = true;
      setDeleteTarget(null);
      mutateFn();
    } catch {
      toast.error("Couldn't delete — try again.");
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  const togglePin = async (thread: ThreadItem) => {
    if (pinBusyIdsRef.current.has(thread.id)) return;
    pinBusyIdsRef.current.add(thread.id);
    setPinBusyIds((current) => {
      const next = new Set(current);
      next.add(thread.id);
      return next;
    });
    try {
      await pinThread(thread.id, !thread.pinned);
      mutateFn();
    } catch {
      toast.error(
        thread.pinned
          ? "Couldn't unpin — try again."
          : "Couldn't pin — try again."
      );
    } finally {
      pinBusyIdsRef.current.delete(thread.id);
      setPinBusyIds((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const runExport = async (thread: ThreadItem) => {
    if (exportBusyIdsRef.current.has(thread.id)) return;
    exportBusyIdsRef.current.add(thread.id);
    setExportBusyIds((current) => {
      const next = new Set(current);
      next.add(thread.id);
      return next;
    });
    try {
      await exportThread(thread.id, thread.title);
    } catch {
      toast.error("Couldn't export — try again.");
    } finally {
      exportBusyIdsRef.current.delete(thread.id);
      setExportBusyIds((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  // A single thread row (select button + per-thread actions), in a project's
  // section or in "Requiring Attention", where `withProject` names its
  // project. The Pin ↔ Unpin action follows `thread.pinned`.
  const renderThreadCard = (thread: ThreadItem, withProject = false) => {
    const project =
      withProject && thread.workspaceDir
        ? projectByKey.get(thread.workspaceDir)
        : undefined;
    const pinBusy = pinBusyIds.has(thread.id);
    const exportBusy = exportBusyIds.has(thread.id);

    return (
      <div
        key={thread.id}
        className="group relative"
      >
        {/* Selectable row — a native button so Enter/Space and role come for
          free. Action buttons are SIBLINGS (below), never nested inside. */}
        <button
          type="button"
          onClick={() => onThreadSelect(thread.id)}
          className={cn(
            "grid w-full cursor-pointer items-center gap-2 rounded-md py-2 pl-2.5 pr-12 text-left transition-colors duration-200 md:pr-2.5 md:group-focus-within:pr-28 md:group-hover:pr-28",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            currentThreadId === thread.id
              ? "border border-primary bg-accent hover:bg-accent"
              : "border border-transparent bg-transparent"
          )}
          aria-current={currentThreadId === thread.id}
        >
          <div className="min-w-0 flex-1">
            {/* Title + Timestamp Row */}
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                {thread.pinned && (
                  <Pin
                    className="size-3 flex-shrink-0 text-[var(--brand)]"
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">{thread.title}</span>
              </h3>
              <span className="ml-2 flex-shrink-0 text-xs tabular-nums text-muted-foreground">
                <time
                  dateTime={thread.updatedAt.toISOString()}
                  title={formatFullTime(thread.updatedAt)}
                >
                  {formatTime(thread.updatedAt, now)}
                </time>
              </span>
            </div>
            {/* Description + Status Row */}
            <div className="flex items-center justify-between">
              <p className="flex-1 truncate text-[13px] text-muted-foreground">
                {project && (
                  <span
                    className="mr-1.5 rounded bg-muted px-1 py-px text-[11px] font-medium text-foreground"
                    title={project.key}
                  >
                    {project.name}
                  </span>
                )}
                {thread.runDir && (
                  <span
                    className="mr-1.5 rounded bg-muted px-1 py-px font-mono text-[11px]"
                    title={thread.runDir}
                  >
                    runs/{folderName(thread.runDir)}
                  </span>
                )}
                {thread.description}
              </p>
              <div className="ml-2 flex-shrink-0">
                <span
                  role="img"
                  aria-label={`Status: ${STATUS_LABELS[thread.status]}`}
                  title={`Status: ${STATUS_LABELS[thread.status]}`}
                  className={cn(
                    "block h-2 w-2 rounded-full",
                    getThreadColor(thread.status)
                  )}
                />
              </div>
            </div>
          </div>
        </button>
        {/* Per-thread actions — siblings of the select button (not nested).
          Touch widths get one 44px "⋯" menu so the title keeps the row; four
          always-visible icons left a 320px title with a few characters.
          `modal={false}`: Rename/Delete hand over to a Dialog, which does its
          own focus trapping and scroll locking. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for "${thread.title}"`}
              data-thread-actions={thread.id}
              className="absolute right-0.5 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground md:hidden"
            >
              <MoreHorizontal
                className="size-4"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="min-h-11"
              disabled={pinBusy}
              onSelect={() => togglePin(thread)}
            >
              {thread.pinned ? (
                <PinOff aria-hidden="true" />
              ) : (
                <Pin aria-hidden="true" />
              )}
              {thread.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => {
                menuOriginRef.current = thread.id;
                setRenameTarget(thread);
                setRenameValue(thread.title);
              }}
            >
              <Pencil aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              disabled={exportBusy}
              onSelect={() => runExport(thread)}
            >
              <Download aria-hidden="true" />
              Export JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-11 text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={() => {
                menuOriginRef.current = thread.id;
                setDeleteTarget(thread);
              }}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Desktop keeps the inline toolbar, revealed on hover/focus. */}
        <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 rounded-md bg-accent/95 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 md:flex">
          <button
            type="button"
            aria-label={
              thread.pinned
                ? `Unpin "${thread.title}"`
                : `Pin "${thread.title}"`
            }
            title={thread.pinned ? "Unpin" : "Pin"}
            onClick={() => togglePin(thread)}
            disabled={pinBusy}
            className={cn(
              "rounded p-1 transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              thread.pinned
                ? "text-[var(--brand)] hover:text-[var(--brand)]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {thread.pinned ? (
              <PinOff
                className="size-3.5"
                aria-hidden="true"
              />
            ) : (
              <Pin
                className="size-3.5"
                aria-hidden="true"
              />
            )}
          </button>
          <button
            type="button"
            aria-label={`Rename "${thread.title}"`}
            title="Rename"
            onClick={() => {
              setRenameTarget(thread);
              setRenameValue(thread.title);
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pencil
              className="size-3.5"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            aria-label={`Export "${thread.title}" as JSON`}
            title="Export JSON"
            onClick={() => runExport(thread)}
            disabled={exportBusy}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exportBusy ? (
              <Loader2
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Download
                className="size-3.5"
                aria-hidden="true"
              />
            )}
          </button>
          <button
            type="button"
            aria-label={`Delete "${thread.title}"`}
            title="Delete"
            onClick={() => setDeleteTarget(thread)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2
              className="size-3.5"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <button
        ref={newChatRef}
        type="button"
        onClick={() => {
          if (onNewChat) {
            onNewChat();
          } else {
            setThreadId(null);
            setView(null);
          }
          onClose?.();
        }}
        className="flex flex-shrink-0 items-center gap-2.5 border-b border-border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <SquarePen
          className="size-4"
          aria-hidden="true"
        />
        New Chat
      </button>
      <button
        type="button"
        onClick={() => {
          if (view === "skills") {
            setView(null);
            onClose?.();
            return;
          }
          setView("skills");
          onClose?.();
        }}
        className={cn(
          "flex flex-shrink-0 items-center gap-2.5 border-b border-border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          view === "skills" && "bg-accent"
        )}
      >
        <Puzzle
          className="size-4"
          aria-hidden="true"
        />
        Research Skills
      </button>
      <button
        type="button"
        onClick={() => {
          if (view === "experts") {
            setView(null);
            onClose?.();
            return;
          }
          setView("experts");
          onClose?.();
        }}
        className={cn(
          "flex flex-shrink-0 items-center gap-2.5 border-b border-border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          view === "experts" && "bg-accent"
        )}
      >
        <Users
          className="size-4"
          aria-hidden="true"
        />
        Experts
      </button>
      <button
        type="button"
        onClick={() => {
          if (view === "memory") {
            setView(null);
            onClose?.();
            return;
          }
          markMemorySeen();
          setView("memory");
          onClose?.();
        }}
        className={cn(
          "flex flex-shrink-0 items-center gap-2.5 border-b border-border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          view === "memory" && "bg-accent"
        )}
      >
        <BrainCircuit
          className="size-4"
          aria-hidden="true"
        />
        EvoMemory
        {view !== "memory" && memoryUnseen > 0 && (
          <span
            className="ml-auto inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--brand-solid)] px-1 text-[10px] font-bold leading-none text-[var(--brand-foreground)]"
            title={`${memoryUnseen} memory file${
              memoryUnseen === 1 ? "" : "s"
            } updated since you last looked`}
            aria-label={`${memoryUnseen} memory updates`}
          >
            {memoryUnseen}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => {
          if (view === "schedule") {
            setView(null);
            onClose?.();
            return;
          }
          setView("schedule");
          onClose?.();
        }}
        className={cn(
          "flex flex-shrink-0 items-center gap-2.5 border-b border-border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          view === "schedule" && "bg-accent"
        )}
      >
        <Clock
          className="size-4"
          aria-hidden="true"
        />
        Scheduled
      </button>
      <div className="flex-shrink-0 border-b border-border p-2.5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            name="research-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search research…"
            aria-label="Search research"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear research search"
              onClick={() => setSearch("")}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X
                className="size-3.5"
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      </div>
      <div className="grid flex-shrink-0 grid-cols-[1fr_auto] items-center gap-2 border-b border-border px-3 py-2.5">
        <h2 className="text-base font-semibold tracking-tight">Recents</h2>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All</SelectItem>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Active</SelectLabel>
                <SelectItem value="idle">
                  <StatusFilterItem
                    status="idle"
                    label="Idle"
                  />
                </SelectItem>
                <SelectItem value="busy">
                  <StatusFilterItem
                    status="busy"
                    label="Busy"
                  />
                </SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Attention</SelectLabel>
                <SelectItem value="interrupted">
                  <StatusFilterItem
                    status="interrupted"
                    label="Interrupted"
                    badge={interruptedCount}
                  />
                </SelectItem>
                <SelectItem value="error">
                  <StatusFilterItem
                    status="error"
                    label="Error"
                  />
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {onClose && (
            <button
              type="button"
              aria-label={view ? "Close navigation" : "Close research"}
              onClick={onClose}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X
                className="size-4"
                aria-hidden="true"
              />
            </button>
          )}
        </div>
      </div>

      <ScrollArea className="h-0 flex-1">
        <div className="box-border w-full max-w-full overflow-hidden p-1.5">
          {showAttention && interruptedThreads.error && (
            <p
              role="alert"
              className="px-2.5 py-1.5 text-xs text-red-600"
            >
              Couldn't check for conversations waiting for you.
            </p>
          )}
          {attentionShown.length > 0 && (
            <section
              aria-label="Requiring Attention"
              className="mb-3"
            >
              <h4 className="m-0 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Requiring Attention
              </h4>
              <div className="flex flex-col gap-1">
                {attentionShown.map((thread) => renderThreadCard(thread, true))}
              </div>
            </section>
          )}

          {ready && projectList.length === 0 && (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <MessageSquare className="mb-2 h-12 w-12 text-gray-300" />
              <p className="text-sm text-muted-foreground">No projects yet.</p>
            </div>
          )}

          {projectList.map((project) => (
            <ProjectSection
              key={project.key}
              project={project}
              open={open.has(project.key)}
              onToggle={() => toggleSection(project.key)}
              busy={busyProjects.has(project.key)}
              waiting={waitingByProject.get(project.key) ?? 0}
              onNewChat={
                onNewChat && !project.missing
                  ? () => {
                      onNewChat(project.key);
                      onClose?.();
                    }
                  : undefined
              }
              onRemove={() => openRemoveProject(project)}
            >
              <ThreadGroups
                scope={{ project: project.key }}
                status={statusParam}
                search={search}
                exclude={attentionIds}
                now={now}
                revision={revision}
                renderThread={(thread) => renderThreadCard(thread)}
                emptyText="No research in this project yet."
              />
            </ProjectSection>
          ))}

          {ready && (
            <button
              type="button"
              onClick={() => openAddProject()}
              className="mb-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FolderPlus
                className="size-3.5 flex-shrink-0"
                aria-hidden="true"
              />
              Add project
            </button>
          )}

          {ready && (
            <ProjectSection
              title="No project"
              detail="Conversations that record no folder: pick a project in the composer to continue one."
              open={open.has(NO_PROJECT_SECTION)}
              onToggle={() => toggleSection(NO_PROJECT_SECTION)}
            >
              <ThreadGroups
                scope="noProject"
                status={statusParam}
                search={search}
                exclude={attentionIds}
                now={now}
                revision={revision}
                renderThread={(thread) => renderThreadCard(thread)}
                emptyText="None."
              />
            </ProjectSection>
          )}
        </div>
      </ScrollArea>

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          // Don't let Escape / backdrop close the dialog mid-save.
          if (!open && !actionBusy) setRenameTarget(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={restoreMenuFocus}
        >
          <DialogHeader>
            <DialogTitle>Rename research</DialogTitle>
            <DialogDescription>
              Give this conversation a custom title.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              // An Enter that ends IME composition only confirms the text.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                submitRename();
              }
            }}
            placeholder="Enter a title…"
            maxLength={100}
            disabled={actionBusy}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={submitRename}
              disabled={actionBusy || !renameValue.trim()}
            >
              {actionBusy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          // Don't let Escape / backdrop close the dialog mid-delete.
          if (!open && !actionBusy) setDeleteTarget(null);
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(e) => {
            // After a delete the trigger row is gone — send focus to New Chat
            // instead of letting it fall to <body>.
            if (pendingDeleteFocusRef.current) {
              e.preventDefault();
              pendingDeleteFocusRef.current = false;
              menuOriginRef.current = null;
              newChatRef.current?.focus();
              return;
            }
            // Cancelled: back to the row's "⋯" trigger if that is where it began.
            restoreMenuFocus(e);
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete this research?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.title}” will be permanently deleted. This can’t be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={actionBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {actionBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The key of the "No project" section in the set of open sections. */
const NO_PROJECT_SECTION = "\u0000no-project";

/**
 * A collapsible section of the list: a project (its folder's name, the full
 * path on hover, a marker while one of its conversations runs, how many
 * wait for the user, and whether its folder is missing), or "No project".
 */
function ProjectSection({
  project,
  title,
  detail,
  open,
  onToggle,
  busy = false,
  waiting = 0,
  onNewChat,
  onRemove,
  children,
}: {
  project?: Project;
  title?: string;
  detail?: string;
  open: boolean;
  onToggle: () => void;
  busy?: boolean;
  waiting?: number;
  /** Start a new chat in this project (absent: no such action). */
  onNewChat?: () => void;
  /** Remove this project from the sidebar (absent: no such action). */
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  const name = project?.name ?? title ?? "";
  const id = useId();
  return (
    <section
      aria-label={name}
      className="mb-1"
    >
      <div className="flex items-center">
        <h4 className="m-0 min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`${id}-threads`}
            aria-describedby={`${id}-detail`}
            title={project?.key ?? detail}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-semibold transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                "size-3.5 flex-shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90"
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{name}</span>
            {project?.missing && (
              <span className="flex-shrink-0 rounded bg-destructive/10 px-1 py-px text-[11px] font-medium text-destructive">
                folder missing
              </span>
            )}
            <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
              {!open && waiting > 0 && (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-flex min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold leading-4 text-white"
                  >
                    {waiting}
                  </span>
                  <span className="sr-only">{`, ${waiting} waiting for you`}</span>
                </>
              )}
              {busy && (
                <span
                  role="img"
                  aria-label="A conversation is running"
                  title="A conversation is running"
                  className="size-2 rounded-full bg-blue-500"
                />
              )}
            </span>
          </button>
        </h4>
        {onNewChat && (
          <button
            type="button"
            onClick={onNewChat}
            aria-label={`New chat in ${name}`}
            title={`New chat in ${name}`}
            className="ml-0.5 flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus
              className="size-3.5"
              aria-hidden="true"
            />
          </button>
        )}
        {onRemove && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for project ${name}`}
                className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground"
              >
                <MoreHorizontal
                  className="size-3.5"
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="min-h-11 md:min-h-0"
                onSelect={onRemove}
              >
                <FolderMinus aria-hidden="true" />
                Remove from sidebar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <span
        id={`${id}-detail`}
        className="sr-only"
      >
        {project?.key ?? detail}
      </span>
      <div
        id={`${id}-threads`}
        className="pl-1"
      >
        {open && children}
      </div>
    </section>
  );
}
