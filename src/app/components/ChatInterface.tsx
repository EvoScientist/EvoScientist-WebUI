"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  FormEvent,
  Fragment,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Square,
  ArrowUp,
  ArrowDown,
  CheckCircle,
  Clock,
  Circle,
  FileIcon,
  FolderOpen,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Paperclip,
  X,
  Pencil,
  CornerDownRight,
  Trash2,
  GripVertical,
  Ellipsis,
  ListX,
} from "lucide-react";
import { ChatMessage } from "@/app/components/ChatMessage";
import {
  ActionGroup,
  type GroupedActionItem,
} from "@/app/components/ActionGroup";
import { CompactionSummary } from "@/app/components/CompactionSummary";
import { ResearchDashboard } from "@/app/components/ResearchDashboard";
import {
  DynamicWorkflowPanel,
  DynamicWorkflowTrigger,
} from "@/app/components/DynamicWorkflowPanel";
import { isSummarizationMessage } from "@/lib/summarization";
import { useCollapseAgentActions } from "@/lib/uiSettings";
import {
  approvalSurface,
  buildToolApprovalResume,
  interruptIdOf,
} from "@/lib/hitl";
import { InterruptApprovalFallback } from "@/app/components/InterruptApprovalFallback";
import {
  AskUserInterrupt,
  type AskUserQuestion,
} from "@/app/components/AskUserInterrupt";
import type {
  TodoItem,
  ToolCall,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Message } from "@langchain/langgraph-sdk";
import {
  extractStringFromMessageContent,
  getMessageToolCalls,
  stringifyUnknown,
} from "@/app/utils/utils";
import { useChatContext } from "@/providers/ChatProvider";
import { useTeams } from "@/app/hooks/useTeams";
import { ExpertsPill } from "@/app/components/ExpertsPill";
import { GoalPill } from "@/app/components/GoalPill";
import {
  goalPageActions,
  goalRefusal,
  goalRequest,
  goalSummary,
  goalUsageLine,
  NO_GOAL_TEXT,
  parseGoalCommand,
  type GoalCommand,
  type GoalPageActionKind,
} from "@/lib/goalCommand";
import { SlashSkillMenu } from "@/app/components/SlashSkillMenu";
import { ComposerChip } from "@/app/components/ComposerChip";
import { SwapText } from "@/app/components/SwapText";
import {
  composerLead,
  mayPin,
  oneSkill,
  pinLead,
  previewLead,
  GOAL_LEADS,
  type ComposerChip as ComposerChipValue,
  type GoalMode,
} from "@/lib/composerChip";
import { canAnimate, prefersReducedMotion } from "@/lib/motion";
import { pyStrip } from "@/lib/pythonWhitespace";
import { pinnedSkillName } from "@/lib/pinnedSkill";
import { useSlashMenu } from "@/app/hooks/useSlashMenu";
import { useOverflowing } from "@/app/hooks/useOverflowing";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { formatModel } from "@/lib/model";
import {
  getThreadAutoApprove,
  setThreadAutoApprove,
  migrateNewThreadAutoApprove,
} from "@/lib/autoApprove";
import {
  agentLabel,
  asyncTaskReportKey,
  asyncUpdateMatchesTask,
  asyncUpdateMessageKey,
  countRunning,
  formatAsyncUpdateMessage,
  isTerminalStatus,
  type MainChatReporter,
} from "@/lib/asyncAgents";
import { useAsyncAgents } from "@/app/hooks/useAsyncAgents";
import { useAutoNotify } from "@/app/hooks/useAutoNotify";
import { taskSubAgentName, type SubAgentStep } from "@/lib/subAgentActivity";
import {
  loadThreadSubAgentSteps,
  saveThreadSubAgentSteps,
} from "@/lib/subAgentStepsStore";
import { useAutoApproveInterrupt } from "@/app/hooks/useAutoApproveInterrupt";
import { useApprovalPolicy } from "@/app/hooks/useApprovalPolicy";
import { useProjects } from "@/providers/ProjectsProvider";
import { findProject, projectHandle } from "@/lib/projects";
import { CHAT_GRAPH_ID } from "@/lib/workspaceAssistant";
import { useDeployment } from "@/providers/ClientProvider";
import { resolveApprovalDecisions } from "@/lib/hitlPolicy";
import {
  getThreadAutoNotifyReportedKeys,
  initializeThreadAutoNotifyReports,
  isThreadAutoNotifyInitialized,
  markThreadAutoNotifyReported,
} from "@/lib/autoNotify";
import { useStickToBottom } from "use-stick-to-bottom";
import { FilesPopover } from "@/app/components/TasksFilesSidebar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQueryState } from "nuqs";
import { toast } from "sonner";
import { useFilePane } from "@/providers/filePaneContext";
import {
  parseModelCommand,
  type ModelCommand,
  type ModelOverride,
} from "@/lib/modelCommand";
import { modelPageEntries, modelPageModels } from "@/lib/modelPage";
import type { MenuIcon, MenuPage, MenuRow } from "@/lib/slashMenu";
import { useAvailableModels } from "@/app/hooks/useAvailableModels";
import type { NavTarget } from "@/lib/navTarget";

interface ChatInterfaceProps {
  // Open the right inspector on its Agents tab (composer "agents running" pulse).
  onShowAgents?: () => void;
  // Navigate to a memory tab / the schedule view from the empty-state dashboard.
  onNavigate?: (target: NavTarget) => void;
  // Open a pinned thread from the empty-state dashboard.
  onOpenThread?: (id: string) => void;
  // Whether the workspace inspector is currently visible.
  workspaceOpen?: boolean;
  // Register a "submit a message on THIS (main) thread" function up to page so
  // the Agents board can loop an async result back to the main agent. Returns
  // false if the main chat is mid-run (can't take a turn). Cleared on unmount.
  onNotifyReady?: (notify: MainChatReporter | null) => void;
  // Pre-fill for a freshly mounted composer — the message that was in flight
  // (plus any draft/queue) when its thread turned out to be gone (see page.tsx
  // `handleThreadUnavailable`). Only ever seeds an empty composer.
  draftSeed?: ComposerSnapshot | null;
  // Register a getter for the current unsent composer state (draft + queue +
  // attachments), folded with a message that didn't go out, up to the page,
  // so it can be carried across a session remount. Cleared on unmount.
  onComposerSnapshotReady?: (
    getSnapshot: ((unsent?: string | null) => ComposerFold) | null
  ) => void;
}

const NO_ACTION_REQUESTS: ActionRequest[] = [];

const SUGGESTED_PROMPTS = [
  "Survey recent papers on a topic",
  "Design an experiment plan",
  "Analyze workspace files",
];

export interface UploadedWorkspaceFile {
  name: string;
  path: string;
  size: number;
}

// A message typed while the agent is busy. It waits in the queue and is sent
// verbatim (append-only — never replaces what's already in the thread) once the
// current turn finishes or is stopped. Each carries its own attached files.
interface QueuedMessage {
  id: number;
  text: string;
  files: UploadedWorkspaceFile[];
  threadId: string | null;
}

// Everything the user has typed but not yet sent: the composer draft plus any
// queued follow-ups (flattened), with their attachments. Captured by the page
// right before it tears the chat session down for a vanished thread, so a
// remount cannot lose it.
export interface ComposerSnapshot {
  text: string;
  files: UploadedWorkspaceFile[];
}

/** The composer's unsent state folded with a message that didn't go out;
 *  `unsentBack` says whether that message is in `text`. */
export interface ComposerFold extends ComposerSnapshot {
  unsentBack: boolean;
}

// Build the message body sent to the backend, appending the same workspace-file
// annotation handleSubmit uses so queued messages keep their attachments.
function formatMessageWithFiles(
  text: string,
  files: UploadedWorkspaceFile[]
): string {
  const workspaceFiles =
    files.length > 0
      ? `\n\nWorkspace files uploaded for this request:\n${files
          .map((file) => `- ${file.path}`)
          .join("\n")}`
      : "";
  return `${text}${workspaceFiles}`;
}

// Everything typed but not sent, in order: the queued messages, then the
// draft, with their attachments once each.
type ComposerItem = Pick<QueuedMessage, "text" | "files">;

function unsentSnapshot(
  queued: ComposerItem[],
  draft: string,
  attached: UploadedWorkspaceFile[]
): ComposerSnapshot {
  const text = [...queued.map((m) => m.text), draft]
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");
  const seen = new Set<string>();
  const files = [...queued.flatMap((m) => m.files), ...attached].filter(
    (f) => !seen.has(f.path) && seen.add(f.path)
  );
  return { text, files };
}

/** What comes back to the composer when items weren't sent: messages ahead
 *  of the draft, as unsentSnapshot folds them, but a /goal command only into
 *  an otherwise empty composer, alone: glued to more text, Enter would send
 *  it all as one goal. `isCommand` says what a text would go out as now (on
 *  a backend without goals "/goal …" is a message). The commands left out
 *  are `notSent`, each with its own files: on a draft they would go out
 *  with an unrelated message, so the notice names them instead. */
function foldBack(
  items: ComposerItem[],
  draft: string,
  attached: UploadedWorkspaceFile[],
  isCommand: (item: ComposerItem) => boolean
): ComposerSnapshot & { notSent: ComposerItem[] } {
  const commands = items.filter((m) => isCommand(m));
  const messages = items.filter((m) => !isCommand(m));
  const base = unsentSnapshot(messages, draft, attached);
  if (!base.text && base.files.length === 0 && commands.length > 0) {
    const [first, ...others] = commands;
    return { text: first.text.trim(), files: first.files, notSent: others };
  }
  return { ...base, notSent: commands };
}

/** The Goal page's rows say what they do. */
const GOAL_ROW_ICONS: Record<GoalPageActionKind, MenuIcon> = {
  create: "plus",
  amend: "pencil",
  pause: "pause",
  resume: "play",
  clear: "clear",
  show: "details",
};

/** The composer's command words: /goal stays one while goal support is
 *  unknown; only a backend known not to run goals leaves it to skills. */
const COMMAND_WORDS: readonly string[] = ["model", "goal"];
const MODEL_ONLY: readonly string[] = ["model"];

/** A message without pinned skills. */
const NO_PINS: readonly string[] = [];

/** The skills the backend pinned for the user message at `index`: the
 *  pinned_skill markers right after it. */
function pinnedAfter(
  entries: ReadonlyArray<{ message: Message }>,
  index: number
): readonly string[] {
  const names: string[] = [];
  for (let i = index + 1; i < entries.length; i++) {
    const name = pinnedSkillName(entries[i].message);
    if (name === null) break;
    names.push(name);
  }
  return names.length > 0 ? names : NO_PINS;
}

/** One toast for goal mode's hints, each replacing the last. */
const GOAL_HINT_ID = "goal-mode-hint";

/** Whether a page row's label holds what was typed on the page. */
const rowMatches = (label: string, filter: string) =>
  label.toLowerCase().includes(filter.trim().toLowerCase());

/** Whether Enter may read a text as a /goal command in the composer it
 *  comes back to: wherever goals are supported, or not known yet (support
 *  can turn up before Enter); only where they are known to be off is it a
 *  message. What it went out as doesn't matter: the composer's text is read
 *  when it is sent again. */
function goalCommandFor(goalSupported: boolean | undefined) {
  return (item: ComposerItem) =>
    goalSupported !== false && parseGoalCommand(item.text) !== null;
}

/** A text's first line, at most 80 code points: how a notice names it. */
function firstLineOf(text: string): string {
  const line = Array.from(text.trim().split("\n")[0]);
  return line.length > 80 ? `${line.slice(0, 79).join("")}…` : line.join("");
}

/** Copy for one left-out command: "Copied" shows on the button (a toast
 *  would cover the notice on a touch screen, where the stack doesn't open
 *  on hover) and is said once, by sonner's own live region: the toaster is
 *  polite and reads text that changes in a toast, so a status of our own
 *  inside it could be read twice, and so could the button's changing label;
 *  the label is hidden from screen readers and the button keeps its name.
 *  For use inside a sonner toast only. */
function CopyLeftOut({ text, name }: { text: string; name: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        aria-label={`Copy ${name}`}
        onClick={() => {
          void copyText(text).then((ok) => {
            if (ok) setCopied(true);
            else toast.error("Couldn't copy the text.");
          });
        }}
        className="shrink-0 select-none rounded border border-solid border-border px-1.5 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:min-w-11"
      >
        {/* Presses go through to the button: sonner starts a swipe on any
            other target, and a small drift would dismiss the notice. */}
        <span
          aria-hidden="true"
          className="pointer-events-none"
        >
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
      <span className="sr-only select-none">{copied ? "Copied." : ""}</span>
    </>
  );
}

/** The "Not sent" notice's commands: a list for VoiceOver (Safari drops it
 *  without bullets). It scrolls past 10rem and is a Tab stop only while it
 *  does (Safari can't scroll it with the keyboard otherwise). Its focus
 *  outline is drawn 2px outside it: text scrolled to its edges would run
 *  under a ring drawn inside. That outline reaches 4px up, and sonner leaves
 *  2px under the title, so the list sits 2px lower. */
function NotSentList({
  items,
}: {
  items: ReadonlyArray<{ text: string; files: ComposerItem["files"] }>;
}) {
  const [el, setEl] = useState<HTMLUListElement | null>(null);
  const overflowing = useOverflowing(el);
  return (
    <ul
      ref={setEl}
      role="list"
      tabIndex={overflowing === false ? undefined : 0}
      aria-label="Commands not sent"
      className="m-0 mt-0.5 flex max-h-40 list-none flex-col gap-2 overflow-y-auto rounded-sm p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {items.map(({ text, files }, index) => (
        <li
          key={index}
          className="mb-0 flex items-start gap-2"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {text}
            {/* Its files stay in the workspace; named here, as they
                can't come back with it onto another text. */}
            {files.length > 0 && (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Attached: {files.map((f) => f.name).join(", ")}
              </span>
            )}
          </span>
          {/* Two commands can start alike (two amends): say which. */}
          <CopyLeftOut
            text={text}
            name={
              items.length > 1
                ? `${index + 1} of ${items.length}: ${firstLineOf(text)}`
                : firstLineOf(text)
            }
          />
        </li>
      ))}
    </ul>
  );
}

/** Commands that didn't go out and couldn't come back to the composer: one
 *  notice that stays until closed, listing them in order (it scrolls), each
 *  with its own Copy, since copied together they would read as one goal. */
function sayNotSent(left: ComposerItem[]) {
  const items = left
    .map((m) => ({ text: m.text.trim(), files: m.files }))
    .filter((m) => m.text);
  if (items.length === 0) return;
  const name =
    items.length > 1 ? `${items.length} commands` : firstLineOf(items[0].text);
  toast.info(`Not sent: ${name}`, {
    duration: Infinity,
    description: <NotSentList items={items} />,
  });
}

// What sending the composer's text did: a run went out, the text was
// answered at once (/goal show), or it stays with the user (a refused or
// unfinished /goal).
type ComposerSendResult = "sent" | "done" | "kept";

const getStatusIcon = (status: TodoItem["status"], className?: string) => {
  switch (status) {
    case "completed":
      return (
        <CheckCircle
          size={16}
          className={cn("text-[var(--color-success)]", className)}
        />
      );
    case "in_progress":
      return (
        <Clock
          size={16}
          className={cn("text-[var(--color-warning)]", className)}
        />
      );
    default:
      return (
        <Circle
          size={16}
          className={cn("text-[var(--color-text-tertiary)]", className)}
        />
      );
  }
};

export const ChatInterface = React.memo<ChatInterfaceProps>(
  ({
    onShowAgents,
    onNotifyReady,
    onNavigate,
    onOpenThread,
    workspaceOpen,
    draftSeed,
    onComposerSnapshotReady,
  }) => {
    const [metaOpen, setMetaOpen] = useState<
      "tasks" | "files" | "workflow" | null
    >(null);
    const tasksContainerRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const chipHintId = useId();
    // The composer box, which the `/` menu sits above.
    const composerRef = useRef<HTMLDivElement | null>(null);
    const uploadInputRef = useRef<HTMLInputElement | null>(null);

    const [input, setInput] = useState("");
    // The installed skills' names a chip can show (the `/` menu reads them).
    const [knownSkills, setKnownSkills] = useState<ReadonlySet<string> | null>(
      null
    );
    // Where a skill was picked in the menu: its chip flies in from there.
    const [flyFrom, setFlyFrom] = useState<{
      name: string;
      rect: DOMRect | null;
    } | null>(null);
    // A chip removed by the user, folding away: each its own element (seq),
    // so one removed while the last still folds starts its own fold.
    const [leavingChip, setLeavingChip] = useState<{
      chip: ComposerChipValue;
      seq: number;
    } | null>(null);
    const leaveSeq = useRef(0);
    const foldChip = (chip: ComposerChipValue) =>
      setLeavingChip({ chip, seq: (leaveSeq.current += 1) });
    // The pick a chip flew in from: given to the chip mounted with it, never
    // to a later one (the same skill typed again or handed back pops).
    const flown = useRef<typeof flyFrom>(null);
    useLayoutEffect(() => {
      flown.current = flyFrom;
    });
    // Goal mode, which only the Goal page starts: the box's text goes out as
    // the goal (or its amendment) after the mode's words.
    const [goalMode, setGoalMode] = useState<GoalMode | null>(null);
    // The `/model` command and the model pill open the menu's Model page; a
    // submit (Send pressed with a page open) closes the menu.
    const openModelPageRef = useRef(() => {});
    const closeMenuRef = useRef(() => {});
    // A send held until the skill names arrive (several leading /words): the
    // text it held, sent once they do.
    const heldRef = useRef<string | null>(null);
    const [pendingFiles, setPendingFiles] = useState<UploadedWorkspaceFile[]>(
      []
    );
    useEffect(() => {
      if (!draftSeed) return;
      const { text, files } = draftSeed;
      if (text) setInput((current) => (current.trim() ? current : text));
      if (files.length > 0) {
        setPendingFiles((current) => (current.length > 0 ? current : files));
      }
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(text.length, text.length);
        }
      });
    }, [draftSeed]);
    const {
      projects,
      refreshing: projectsRefreshing,
      error: projectsError,
      files: filesAccess,
    } = useProjects();
    const [isUploadingFiles, setIsUploadingFiles] = useState(false);
    // Messages typed while the agent is busy are queued. They
    // drain one-per-idle-window into the thread once it's free. A ref mirrors the
    // latest queue so event handlers (key ↑, edit) read current state without
    // being recreated; queueIdRef hands out stable keys.
    const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
    // The goal pill's details; `/goal` (show) opens them.
    const [goalDetailsOpen, setGoalDetailsOpen] = useState(false);
    const queuedMessagesRef = useRef<QueuedMessage[]>(queuedMessages);
    queuedMessagesRef.current = queuedMessages;
    // What the folds see as the draft: goal mode with nothing written is none
    // (a hand-back glued its "/goal" to the text it brought back).
    const foldDraft =
      goalMode !== null &&
      input.startsWith(GOAL_LEADS[goalMode]) &&
      !input.slice(GOAL_LEADS[goalMode].length).trim()
        ? ""
        : input;
    const composerStateRef = useRef({ input: foldDraft, pendingFiles });
    composerStateRef.current = { input: foldDraft, pendingFiles };
    const onComposerSnapshotReadyRef = useRef(onComposerSnapshotReady);
    onComposerSnapshotReadyRef.current = onComposerSnapshotReady;
    useEffect(() => {
      // A gone thread's unsent message and composer, for a new chat: folded
      // like any hand-back, so a /goal command is not glued onto the rest.
      const getSnapshot = (unsent: string | null = null): ComposerFold => {
        const { input: draft, pendingFiles: attached } =
          composerStateRef.current;
        const first: ComposerItem[] = unsent?.trim()
          ? [{ text: unsent, files: [] }]
          : [];
        const back = foldBack(
          [...first, ...queuedMessagesRef.current],
          draft,
          attached,
          // The new chat runs on the chat graph, whatever this thread's.
          goalCommandFor(chatGoalSupportedRef.current)
        );
        sayNotSent(back.notSent);
        return {
          text: back.text,
          files: back.files,
          unsentBack: first.length > 0 && !back.notSent.includes(first[0]),
        };
      };
      onComposerSnapshotReadyRef.current?.(getSnapshot);
      return () => onComposerSnapshotReadyRef.current?.(null);
    }, []);
    const queueIdRef = useRef(0);

    const draggedQueuedMessageIdRef = useRef<number | null>(null);
    const [threadId] = useQueryState("threadId");
    // Auto-approve is per-thread and persisted (see lib/autoApprove): it follows
    // the conversation across view switches (Skills/Memory unmount this), thread
    // switches, and reloads. Seed from storage for whatever thread is active on
    // mount so returning from another view restores the right setting.
    const [autoApprove, setAutoApproveState] = useState(() =>
      getThreadAutoApprove(threadId)
    );
    const [autoApproveDialogOpen, setAutoApproveDialogOpen] = useState(false);
    const {
      registry: modelRegistry,
      loading: modelRegistryLoading,
      error: modelRegistryError,
    } = useAvailableModels();
    // We're on the curated fallback list when the registry fetch settled
    // (not loading) but produced no entries — either an explicit error from
    // the backend's `/api/models` route, or a successful response that came
    // back empty. We log once so dev tools surface the cause.
    const isFallbackModelList =
      !modelRegistryLoading && modelRegistry.entries.length === 0;
    useEffect(() => {
      if (isFallbackModelList) {
        console.warn(
          "[model page] using curated fallback list — registry fetch failed or empty",
          modelRegistryError ?? "(no error message)"
        );
      }
    }, [isFallbackModelList, modelRegistryError]);
    // Picker source: prefer the backend's authoritative registry; fall back
    // to the curated short list when the endpoint isn't available (older
    // deployment, network blip). Registry order is the rank the backend
    // recommends — we don't re-sort.
    const pickerModels = useMemo(
      () => modelPageModels(modelRegistry.entries),
      [modelRegistry.entries]
    );
    const previousThreadIdRef = useRef(threadId);
    const migrateAutoApproveForCreatedThreadRef = useRef(false);
    const { scrollRef, contentRef, scrollToBottom, isAtBottom } =
      useStickToBottom();

    const {
      stream,
      messages,
      todos,
      files,
      ui,
      setFiles,
      isLoading,
      runSettled,
      isThreadLoading,
      interrupt,
      sendMessage,
      abortRun,
      resumeInterrupt,
      subAgentActivity,
      dynamicWorkflows,
      asyncTasks,
      summarizationEvent,
      modelOverride,
      setModelOverride,
      threadGraph,
      canRunNow,
      binding,
      canSend,
      projectKey,
      setRefusalHandler,
      goal,
      goalBusy,
      rubricVerdict,
      goalSupported,
      chatGoalSupported,
      sendGoalRequest,
    } = useChatContext();
    // The chat works in its own project: uploads go to that folder, and the
    // chip names it.
    const chatProject = findProject(projects, projectKey);
    const filesProject =
      filesAccess === "here" && projectKey ? projectHandle(projectKey) : null;
    const filesHere = filesProject !== null;
    const folderLabel = chatProject
      ? { full: chatProject.key, name: chatProject.name }
      : null;
    // Read by the hand-back folds, which are registered once.
    const goalSupportedRef = useRef(goalSupported);
    goalSupportedRef.current = goalSupported;
    const chatGoalSupportedRef = useRef(chatGoalSupported);
    chatGoalSupportedRef.current = chatGoalSupported;

    // A bare/leftover interrupt value (e.g. after Stop) must NOT lock the input.
    const interruptValue = interrupt?.value as
      | { type?: string; action_requests?: unknown[] }
      | undefined;
    const hasPendingInterrupt =
      interruptValue?.type === "ask_user" ||
      (Array.isArray(interruptValue?.action_requests) &&
        interruptValue.action_requests.length > 0);

    // The goal's details close with the goal: left open, they would pop up
    // by themselves for the next one.
    if (!goal && goalDetailsOpen) setGoalDetailsOpen(false);

    // Goal mode lasts while the box starts with its words and goals run
    // here: a send, a text put back from outside or a backend without goals
    // ends it (what is left is ordinary text).
    const goalModeOn =
      goalMode !== null &&
      goalSupported === true &&
      input.startsWith(GOAL_LEADS[goalMode]);
    if (goalMode !== null && !goalModeOn) setGoalMode(null);
    const activeGoalMode = goalModeOn ? goalMode : null;

    // A goal with nothing written: the box shakes a little.
    const nudgeComposer = useCallback(() => {
      const el = composerRef.current;
      if (!canAnimate(el) || prefersReducedMotion()) return;
      el.animate(
        [
          { transform: "none" },
          { transform: "translateX(-3px)", offset: 0.2 },
          { transform: "translateX(3px)", offset: 0.4 },
          { transform: "translateX(-2px)", offset: 0.6 },
          { transform: "translateX(2px)", offset: 0.8 },
          { transform: "none" },
        ],
        { duration: 280, easing: "ease" }
      );
    }, []);

    // /goal, answered the way the core's GoalCommand answers it: show opens
    // the goal pill, a refusal is said in the core's words, and anything else
    // becomes a goal request run. `text` is what was typed, handed back if
    // the backend refuses the run.
    const runGoalCommand = useCallback(
      (command: GoalCommand, text = ""): ComposerSendResult => {
        if (command.kind === "show") {
          if (goal) setGoalDetailsOpen(true);
          else toast.info(NO_GOAL_TEXT);
          return "done";
        }
        if (command.kind === "usage") {
          const usage = goalUsageLine("/goal amend <feedback>");
          if (usage) {
            toast.warning(`Usage: ${usage.command}`, {
              description: usage.description,
            });
          }
          return "kept";
        }
        const refusal = goalRefusal(command, goal);
        if (refusal) {
          toast.warning(refusal);
          return "kept";
        }
        return sendGoalRequest(goalRequest(command, goal), text)
          ? "sent"
          : "kept";
      },
      [goal, sendGoalRequest]
    );
    // Where the composer's text becomes a run, typed or drained from the
    // queue: a /goal command goes as a goal request, anything else as a
    // message. A backend without goals gets "/goal …" as a message, as before.
    const sendComposerText = useCallback(
      (text: string, files: UploadedWorkspaceFile[]): ComposerSendResult => {
        const command = goalSupported === true ? parseGoalCommand(text) : null;
        // A goal can't carry files: Enter refuses them, and so does a drain
        // (a "/goal …" queued while goal support was unknown).
        if (command && files.length > 0) {
          toast.warning("A goal can't carry files; send them in a message.");
          return "kept";
        }
        if (command) return runGoalCommand(command, text);
        return sendMessage(formatMessageWithFiles(text, files))
          ? "sent"
          : "kept";
      },
      [goalSupported, runGoalCommand, sendMessage]
    );
    // A message the backend refused comes back to the composer at the moment
    // it is refused, followed by everything queued after it and then the
    // draft, and the queue is left empty: the fold the page makes for a
    // thread that is gone, here for the open one. Nothing goes out on its
    // own, and the order holds.
    useEffect(() => {
      // True when the text came back to the composer.
      setRefusalHandler((text) => {
        const { input: draft, pendingFiles: attached } =
          composerStateRef.current;
        const refused: ComposerItem = { text, files: [] };
        const back = foldBack(
          [refused, ...queuedMessagesRef.current],
          draft,
          attached,
          goalCommandFor(goalSupportedRef.current)
        );
        setQueuedMessages([]);
        // Text brought back is text: goal mode ends with what it held (a
        // draft only trimmed is the same text).
        if (back.text !== draft.trim()) setGoalMode(null);
        setInput(back.text);
        setPendingFiles(back.files);
        sayNotSent(back.notSent);
        return !back.notSent.includes(refused);
      });
      return () => setRefusalHandler(null);
    }, [setRefusalHandler]);
    // The docked file pane (inspector) shows this conversation's agent-state
    // files and re-reads open files when the agent may have written them.
    const filePane = useFilePane();
    const registerChatFiles = filePane?.registerChat;
    const notifyFilesMayHaveChanged = filePane?.notifyFilesMayHaveChanged;
    // Saving a file writes a checkpoint on the thread, so it follows the
    // thread's read-only rule like a run.
    const fileEditDisabled =
      !canSend || isLoading === true || interrupt !== undefined;
    useEffect(() => {
      registerChatFiles?.({
        threadId,
        files,
        setFiles,
        editDisabled: fileEditDisabled,
        project: filesProject,
      });
    }, [
      registerChatFiles,
      threadId,
      files,
      setFiles,
      fileEditDisabled,
      filesProject,
    ]);
    useEffect(() => () => registerChatFiles?.(null), [registerChatFiles]);
    // A tool result we haven't seen means a tool call just finished. Results
    // already in the thread when it loads don't count.
    const seenToolResultsRef = useRef<Set<string> | null>(null);
    useEffect(() => {
      if (isThreadLoading) return;
      const ids = messages
        .filter((m) => m.type === "tool" && m.id)
        .map((m) => m.id as string);
      const seen = seenToolResultsRef.current;
      if (seen === null) {
        seenToolResultsRef.current = new Set(ids);
        return;
      }
      let fresh = false;
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          fresh = true;
        }
      }
      if (fresh) notifyFilesMayHaveChanged?.();
    }, [messages, isThreadLoading, notifyFilesMayHaveChanged]);
    // The end of a turn covers sub-agents, whose tool calls aren't in this
    // thread's messages.
    const wasLoadingRef = useRef(isLoading);
    useEffect(() => {
      if (wasLoadingRef.current && !isLoading) notifyFilesMayHaveChanged?.();
      wasLoadingRef.current = isLoading;
    }, [isLoading, notifyFilesMayHaveChanged]);
    // Names only — used to tell expert dispatches apart in the fan-out panel.
    const { teams: installedExperts } = useTeams();
    const expertNames = useMemo(
      () => new Set(installedExperts.map((t) => t.name)),
      [installedExperts]
    );

    // Count of background async sub-agents (writing / data-analysis) still
    // running — drives the composer's "agents running" pulse. We poll each task's
    // REAL run status (via useAsyncAgents) rather than trusting the conversation
    // state's cached `status`, which only updates when the agent checks and would
    // otherwise keep the pulse on forever. Only polls when tasks actually exist.
    const hasAsyncTasks = Object.keys(asyncTasks ?? {}).length > 0;
    const { tasks: liveAgentTasks } = useAsyncAgents(threadId, {
      enabled: hasAsyncTasks,
    });
    const runningAgents = useMemo(
      () => countRunning(liveAgentTasks),
      [liveAgentTasks]
    );

    const taskToolCallIds = useMemo(() => {
      const ids = new Set<string>();
      for (const message of messages) {
        if (message.type !== "ai") continue;
        // The calls the chat shows, so a task's steps follow its card.
        for (const toolCall of getMessageToolCalls(message)) {
          if (toolCall.name === "task" && toolCall.id) ids.add(toolCall.id);
        }
      }
      return ids;
    }, [messages]);

    const completedTaskToolCallIds = useMemo(() => {
      const ids = new Set<string>();
      for (const message of messages) {
        if (message.type !== "tool") continue;
        const id = (message as { tool_call_id?: string }).tool_call_id;
        if (id && taskToolCallIds.has(id)) ids.add(id);
      }
      return ids;
    }, [messages, taskToolCallIds]);

    const storedSubAgentSteps = useMemo(
      () => (threadId ? loadThreadSubAgentSteps(threadId) : {}),
      [threadId]
    );

    const relevantStoredSubAgentSteps = useMemo(() => {
      const out: Record<string, SubAgentStep[]> = {};
      for (const [id, steps] of Object.entries(storedSubAgentSteps)) {
        if (taskToolCallIds.has(id)) out[id] = steps;
      }
      return out;
    }, [storedSubAgentSteps, taskToolCallIds]);

    // The SDK map is already keyed by the exact parent task tool-call id. Keep
    // only ids that occur in this transcript, then fall back to the bounded
    // local cache when the current backend cannot hydrate subgraph checkpoints.
    const liveSubAgentSteps = useMemo(() => {
      const out: Record<string, SubAgentStep[]> = {};
      for (const [id, steps] of Object.entries(subAgentActivity)) {
        if (taskToolCallIds.has(id)) out[id] = steps;
      }
      return out;
    }, [subAgentActivity, taskToolCallIds]);
    const subAgentSteps = useMemo(
      () => ({ ...relevantStoredSubAgentSteps, ...liveSubAgentSteps }),
      [relevantStoredSubAgentSteps, liveSubAgentSteps]
    );

    const persistableSubAgentSteps = useMemo(() => {
      const out: Record<string, SubAgentStep[]> = {
        ...relevantStoredSubAgentSteps,
      };
      for (const [id, steps] of Object.entries(liveSubAgentSteps)) {
        if (completedTaskToolCallIds.has(id) && steps.length > 0) {
          out[id] = steps;
        }
      }
      return out;
    }, [
      completedTaskToolCallIds,
      liveSubAgentSteps,
      relevantStoredSubAgentSteps,
    ]);

    const subAgentStepsFlushRef = useRef({
      threadId: null as string | null,
      map: {} as Record<string, SubAgentStep[]>,
    });
    useEffect(() => {
      subAgentStepsFlushRef.current = {
        threadId,
        map: persistableSubAgentSteps,
      };
      if (!threadId || Object.keys(persistableSubAgentSteps).length === 0)
        return;
      const timer = window.setTimeout(() => {
        saveThreadSubAgentSteps(threadId, persistableSubAgentSteps);
      }, 750);
      return () => window.clearTimeout(timer);
    }, [threadId, persistableSubAgentSteps]);
    useEffect(
      () => () => {
        const { threadId: lastThreadId, map } = subAgentStepsFlushRef.current;
        if (lastThreadId && Object.keys(map).length > 0) {
          saveThreadSubAgentSteps(lastThreadId, map);
        }
      },
      []
    );

    // Auto-report: when on for this thread, a sub-agent that FINISHES while we're
    // watching is looped back to the main agent automatically (same signal as the
    // manual "Notify main chat" button — rendered as a system pill). We baseline
    // tasks already terminal at mount / when the toggle is switched on so we never
    // replay old completions, and only inject while the main chat is idle (one at
    // a time; isLoading gates the rest until the agent finishes the turn).
    const [autoNotify] = useAutoNotify(threadId);
    // Latch covering the gap between submitting an auto-report and `isLoading`
    // flipping true — without it a poll in that window could fire a SECOND report
    // and collide on the main thread. Cleared once the run is confirmed running.
    const autoFireInFlightRef = useRef(false);

    useEffect(() => {
      autoFireInFlightRef.current = false;
    }, [threadId]);

    // Once a run is actually in flight (isLoading true — from a user message, the
    // agent's own turn, or our auto-report), release the latch: the isLoading gate
    // now governs, and the next queued report fires when the thread next goes idle.
    useEffect(() => {
      if (isLoading) autoFireInFlightRef.current = false;
    }, [isLoading]);

    // Re-engage stick-to-bottom whenever a new run starts (sending a message or
    // resuming an interrupt → isLoading flips true). Without this, if the user had
    // drifted even slightly off the bottom after the previous answer, a short new
    // reply would render below the fold and look like nothing happened.
    useEffect(() => {
      if (isLoading) void scrollToBottom();
    }, [isLoading, scrollToBottom]);

    // Register a "notify the main agent" hook up to page (Agents board → "Notify
    // main chat" loops an async result back here). A ref keeps the latest
    // sendMessage/isLoading so the once-registered closure always reads current
    // values. Returns false if a run is in flight (the agent can't take a turn).
    const notifyStateRef = useRef({
      sendMessage,
      isLoading,
      hasPendingInterrupt,
      messages,
      threadId,
      canRunNow,
      readOnly: false,
    });
    notifyStateRef.current = {
      sendMessage,
      isLoading,
      hasPendingInterrupt,
      messages,
      threadId,
      canRunNow,
      readOnly: binding.kind === "readOnly",
    };
    const onNotifyReadyRef = useRef(onNotifyReady);
    onNotifyReadyRef.current = onNotifyReady;
    useEffect(() => {
      const notify: MainChatReporter = (task, expectedThreadId) => {
        const current = notifyStateRef.current;
        if (current.threadId !== expectedThreadId) return "wrong-thread";
        if (current.readOnly) return "read-only";
        // Still loading, or the folder is being read again.
        if (!current.canRunNow()) return "busy";
        if (current.isLoading) return "busy";
        // A report run would drop what waits on the user (a goal's review).
        if (current.hasPendingInterrupt) return "waiting";
        if (
          current.messages.some(
            (message) =>
              message.type === "human" &&
              asyncUpdateMatchesTask(
                extractStringFromMessageContent(message),
                task
              )
          )
        ) {
          return "duplicate";
        }
        markThreadAutoNotifyReported(
          expectedThreadId,
          asyncTaskReportKey(task)
        );
        current.sendMessage(formatAsyncUpdateMessage(task), {
          mode: "followup",
        });
        return "sent";
      };
      onNotifyReadyRef.current?.(notify);
      return () => onNotifyReadyRef.current?.(null);
    }, []);

    // What model will the next turn use? The pill is forward-looking — it
    // updates the moment the user changes (or clears) the override, instead
    // of lingering on what just ran. Priority:
    //   1. Per-thread model override (`/model` command, picker) — the next
    //      run will use this verbatim.
    //   2. The model registry endpoint's reported deployment default —
    //      what the next run will use when no override is set.
    //   3. Last AI message's `response_metadata.model_name` — final fallback
    //      when none of the above are available (older deployment without
    //      `/api/models`).
    // The endpoint's `default` can disagree with what the runtime actually
    // boots with; that's a backend honesty problem and tracked separately.
    // Token/context usage is intentionally NOT shown — the backend doesn't
    // persist usage_metadata, so it isn't reliably available here.
    const currentModel = useMemo(() => {
      if (modelOverride) {
        return formatModel(modelOverride.model, modelOverride.model_provider);
      }
      // Another graph's thread (a scheduled task's) runs on its own model,
      // which the registry's default doesn't describe.
      if (threadGraph !== CHAT_GRAPH_ID) return null;
      if (modelRegistry.defaultEntry) {
        return formatModel(
          modelRegistry.defaultEntry.name,
          modelRegistry.defaultEntry.provider ?? undefined
        );
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type !== "ai") continue;
        const rm = m.response_metadata as Record<string, unknown> | undefined;
        const info = formatModel(
          rm?.model_name ?? rm?.model,
          rm?.model_provider
        );
        if (info) return info;
      }
      return null;
    }, [messages, modelOverride, modelRegistry.defaultEntry, threadGraph]);

    // While the agent waits on an *actionable* interrupt (approval or ask_user),
    // lock the composer so the user answers via the in-message controls — a free
    // message would cancel the pending tool call and corrupt the thread.
    const submitDisabled = isLoading || !canSend || hasPendingInterrupt;
    // Approvals and questions stay on the page while the folder is read
    // again (disabled, so nothing typed or chosen is lost) and are hidden
    // only on a thread that can't run here.
    const interruptsShown = binding.kind !== "readOnly";

    // Drain the user-message queue: when the thread goes idle (and no interrupt is
    // pending), send the head as the next turn. One per idle window — the
    // autoFireInFlightRef latch (shared with auto-report) covers the gap before
    // isLoading flips true so two messages can't race onto the thread. After Stop,
    // isLoading drops and the queue still drains (queued = intent to send).
    useEffect(() => {
      if (
        !canSend ||
        isLoading ||
        hasPendingInterrupt ||
        autoFireInFlightRef.current
      )
        return;
      if (queuedMessages.length === 0) return;
      // Effects from the previous render still run once after a route/thread
      // change. Never let that stale queue drain into the newly selected thread.
      if (queuedMessages[0].threadId !== threadId) return;
      if (!canRunNow()) return;
      autoFireInFlightRef.current = true;
      // An item that sends nothing (a refused /goal) lets the next one take
      // its turn in this pass; what stays with the user comes back to the
      // composer (foldBack), in order.
      const kept: QueuedMessage[] = [];
      let taken = 0;
      let sent = false;
      for (const item of queuedMessages) {
        if (item.threadId !== threadId) break;
        taken += 1;
        const result = sendComposerText(item.text, item.files);
        if (result === "sent") {
          sent = true;
          break;
        }
        if (result === "kept") kept.push(item);
      }
      setQueuedMessages(queuedMessages.slice(taken));
      // No run will release the latch when nothing went out.
      if (!sent) autoFireInFlightRef.current = false;
      if (kept.length > 0) {
        const { input: draft, pendingFiles: attached } =
          composerStateRef.current;
        const back = foldBack(
          kept,
          draft,
          attached,
          goalCommandFor(goalSupportedRef.current)
        );
        if (
          back.text !== draft.trim() ||
          back.files.length !== attached.length
        ) {
          if (back.text !== draft.trim()) setGoalMode(null);
          setInput(back.text);
          setPendingFiles(back.files);
        }
        sayNotSent(back.notSent);
      }
    }, [
      canSend,
      canRunNow,
      isLoading,
      hasPendingInterrupt,
      queuedMessages,
      sendComposerText,
      threadId,
    ]);

    // Clear the queue when switching to a *different* conversation, but NOT on the
    // null→real-id transition that happens when the first message of a brand-new
    // chat creates its thread (the queue belongs to this same conversation).
    const queueThreadRef = useRef(threadId);
    useEffect(() => {
      const prev = queueThreadRef.current;
      queueThreadRef.current = threadId;
      if (prev === null && threadId !== null) {
        // The first submitted message creates the thread asynchronously. Carry
        // any follow-ups queued during that transition into the new thread.
        setQueuedMessages((messages) =>
          messages.map((message) =>
            message.threadId === null ? { ...message, threadId } : message
          )
        );
        return;
      }
      if (prev !== threadId) setQueuedMessages([]);
    }, [threadId]);

    const enableAutoApprove = useCallback(() => {
      setAutoApproveState(true);
      setThreadAutoApprove(threadId, true);
      setAutoApproveDialogOpen(false);
    }, [threadId]);

    const turnOffAutoApprove = useCallback(() => {
      setAutoApproveState(false);
      setThreadAutoApprove(threadId, false);
      setAutoApproveDialogOpen(false);
    }, [threadId]);

    // Follow the thread: when the active thread changes, load THAT thread's saved
    // auto-approve instead of resetting. The null→real-id transition is the new
    // chat getting created on its first message — carry its sentinel setting over.
    useEffect(() => {
      const previousThreadId = previousThreadIdRef.current;
      if (previousThreadId === threadId) return;

      if (
        previousThreadId === null &&
        threadId !== null &&
        migrateAutoApproveForCreatedThreadRef.current
      ) {
        migrateNewThreadAutoApprove(threadId);
      } else if (previousThreadId === null && threadId !== null) {
        // The user selected an existing research from New Chat before sending.
        // Do not leak the pending-new-chat auto-approve sentinel onto that thread.
        setThreadAutoApprove(null, false);
      }

      setAutoApproveState(getThreadAutoApprove(threadId));
      setAutoApproveDialogOpen(false);
      setPendingFiles([]);
      migrateAutoApproveForCreatedThreadRef.current = false;
      previousThreadIdRef.current = threadId;
    }, [threadId]);

    const handleFilesSelected = useCallback(
      async (event: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (selectedFiles.length === 0) return;

        if (!filesProject) return;
        setIsUploadingFiles(true);
        try {
          const formData = new FormData();
          selectedFiles.forEach((file) => formData.append("files", file));
          const response = await fetch(
            `/api/workspace/upload?${new URLSearchParams({
              project: filesProject,
            })}`,
            { method: "POST", body: formData }
          );
          const data = (await response.json()) as {
            files?: UploadedWorkspaceFile[];
            error?: string;
          };
          if (!response.ok || !data.files) {
            throw new Error(data.error || "Failed to upload files.");
          }
          setPendingFiles((currentFiles) => [...currentFiles, ...data.files!]);
          toast.success(
            `${data.files.length} file${
              data.files.length === 1 ? "" : "s"
            } uploaded to the workspace.`
          );
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Failed to upload files."
          );
        } finally {
          setIsUploadingFiles(false);
        }
      },
      [filesProject]
    );

    const removePendingFile = useCallback((filePath: string) => {
      setPendingFiles((currentFiles) =>
        currentFiles.filter((file) => file.path !== filePath)
      );
    }, []);

    // Apply a parsed `/model` command. Three forms:
    //   - show  → open the model picker dialog
    //   - reset → clear the per-thread override (revert to assistant default)
    //   - set   → persist the new override and confirm via toast. Names that
    //             aren't in our curated list are still accepted — the backend
    //             accepts anything `init_chat_model` knows, and we'd rather
    //             not block a power user on our curation lagging the registry.
    // A model chosen on the Model page, and Reset to default: said with a
    // toast either way.
    const chooseModel = useCallback(
      async (m: ModelOverride): Promise<boolean> => {
        try {
          await setModelOverride({
            model: m.model,
            ...(m.model_provider ? { model_provider: m.model_provider } : {}),
          });
          toast.success(
            `Model set to ${m.model}${
              m.model_provider ? ` (${m.model_provider})` : ""
            }.`
          );
          return true;
        } catch (err) {
          toast.error(
            err instanceof Error
              ? `Couldn't update model: ${err.message}`
              : "Couldn't update model — try again."
          );
          return false;
        }
      },
      [setModelOverride]
    );
    const resetModel = useCallback(async (): Promise<boolean> => {
      try {
        await setModelOverride(null);
        toast.success("Model override cleared.");
        return true;
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Couldn't clear override: ${err.message}`
            : "Couldn't clear override — try again."
        );
        return false;
      }
    }, [setModelOverride]);

    const applyModelCommand = useCallback(
      async (cmd: Exclude<ModelCommand, { kind: "show" }>) => {
        // Pre-thread picks are staged in useChat and applied to the first
        // run; no threadId guard needed.
        try {
          if (cmd.kind === "reset") {
            await setModelOverride(null);
            toast.success("Model override cleared.");
          } else {
            const next: ModelOverride = {
              model: cmd.model,
              ...(cmd.provider ? { model_provider: cmd.provider } : {}),
            };
            await setModelOverride(next);
            toast.success(
              `Model set to ${cmd.model}${
                cmd.provider ? ` (${cmd.provider})` : ""
              }.`
            );
          }
        } catch (err) {
          toast.error(
            err instanceof Error
              ? `Couldn't update model: ${err.message}`
              : "Couldn't update model — try again."
          );
        }
      },
      [setModelOverride]
    );

    const handleSubmit = useCallback(
      // `queueIfBusy`: a held send let go joins the queue while a queued
      // message or an auto-report is being started (their latch covers the
      // gap before isLoading) or messages wait, rather than racing them.
      (
        e?: FormEvent,
        { queueIfBusy = false }: { queueIfBusy?: boolean } = {}
      ) => {
        if (e) {
          e.preventDefault();
        }
        const messageText = input.trim();
        if (!messageText) return;
        // Enter on a page is the page's: only Send gets here with one open.
        // It sends what shows, the page's word left out.
        closeMenuRef.current();
        // Several leading /words and no skill names yet: which one the
        // message pins (one skill a message) needs them, since the backend
        // skips /words that aren't skills. The send waits and goes when they
        // arrive; a second Enter sends the text as typed (a read that fails
        // never strands it).
        if (!activeGoalMode && knownSkills === null) {
          const commands = new Set(
            goalSupported === false ? MODEL_ONLY : COMMAND_WORDS
          );
          const first = pinLead(input, commands);
          const several =
            !!first &&
            pinLead(input.slice(first.lead.length), commands) !== null;
          if (several && heldRef.current !== input) {
            heldRef.current = input;
            toast.info(
              "Checking which skill this pins: it sends once the skills are read.",
              { id: "skills-pending" }
            );
            return;
          }
        }
        // A send that goes now (a second Enter: as typed) keeps no promise.
        if (heldRef.current !== null) {
          heldRef.current = null;
          toast.dismiss("skills-pending");
        }
        // Goal mode: nothing written, or a word the core would read as
        // another /goal command, stays here with a hint.
        if (activeGoalMode) {
          const body = pyStrip(input.slice(GOAL_LEADS[activeGoalMode].length));
          if (!body) {
            nudgeComposer();
            toast.info(
              activeGoalMode === "goal"
                ? "Describe the goal first."
                : "Say what should change in the goal first.",
              { id: GOAL_HINT_ID }
            );
            return;
          }
          if (
            activeGoalMode === "goal" &&
            parseGoalCommand(messageText)?.kind !== "create"
          ) {
            toast.warning(
              `“${body}” is a /goal command; describe the goal in more words.`,
              { id: GOAL_HINT_ID }
            );
            return;
          }
        }
        // After a leading /word (a skill's chip) the next word may be the
        // command: /model and /goal answer as typed alone. The word stays for
        // what needs no run; a goal request goes without it (it carries no
        // skill). Read whatever the skill names say, so a text sent before
        // they arrive reads alike (no "/x /goal …" is a message).
        const pin = activeGoalMode
          ? null
          : pinLead(
              input,
              new Set(goalSupported === false ? MODEL_ONLY : COMMAND_WORDS)
            );
        const afterPin = pin ? input.slice(pin.lead.length).trim() : "";
        const commandAfterPin =
          !!afterPin &&
          (parseModelCommand(afterPin) !== null ||
            (goalSupported === true && parseGoalCommand(afterPin) !== null));
        const commandText = commandAfterPin ? afterPin : messageText;
        const keep = commandAfterPin && pin ? pin.lead : "";
        // Intercept `/model` before the agent sees it — purely client-side
        // state on the thread metadata. The textarea clears regardless of
        // outcome so the command echo doesn't linger; a bare `/model` opens
        // the menu's Model page.
        const modelCmd = parseModelCommand(commandText);
        if (modelCmd) {
          if (modelCmd.kind === "show") openModelPageRef.current();
          else void applyModelCommand(modelCmd);
          setInput(keep);
          return;
        }
        const goalCmd =
          goalSupported === true ? parseGoalCommand(commandText) : null;
        if (goalCmd && pendingFiles.length > 0) {
          toast.warning("A goal can't carry files; send them in a message.");
          return;
        }
        // Reading the goal needs no run, so it answers at once, like /model;
        // a goal request waits in the queue like a message. Show is done;
        // the usage line leaves "/goal amend" to be finished.
        if (goalCmd && (goalCmd.kind === "show" || goalCmd.kind === "usage")) {
          runGoalCommand(goalCmd);
          if (goalCmd.kind === "show") setInput(keep);
          return;
        }
        const outText = goalCmd ? commandText : messageText;
        const dropsSkill = () => {
          if (goalCmd && commandAfterPin && pin) {
            toast.info(`A goal doesn't take skills, so /${pin.name} came off.`);
          }
        };
        // Can't compose with no assistant, a pending interrupt, or files still
        // uploading. (Unlike before, isLoading is NOT a blocker — see below.)
        if (!canSend || hasPendingInterrupt || isUploadingFiles) return;
        // Agent busy → queue it. The queue drains and sends
        // automatically once this turn finishes (or is stopped); the message is
        // appended as the next turn — it never replaces what's already running.
        if (
          isLoading ||
          (queueIfBusy &&
            (autoFireInFlightRef.current ||
              queuedMessagesRef.current.length > 0))
        ) {
          setQueuedMessages((prev) => [
            ...prev,
            {
              id: (queueIdRef.current += 1),
              text: outText,
              files: pendingFiles,
              threadId,
            },
          ]);
          dropsSkill();
          setInput("");
          setPendingFiles([]);
          return;
        }
        if (!canRunNow()) return;
        migrateAutoApproveForCreatedThreadRef.current =
          threadId === null && autoApprove;
        // A refused /goal keeps its text: an objective over the limit is to
        // be shortened, amend feedback is wanted again.
        if (sendComposerText(outText, pendingFiles) === "kept") return;
        dropsSkill();
        setInput("");
        setPendingFiles([]);
      },
      [
        input,
        knownSkills,
        activeGoalMode,
        nudgeComposer,
        applyModelCommand,
        canSend,
        canRunNow,
        hasPendingInterrupt,
        autoApprove,
        isLoading,
        isUploadingFiles,
        pendingFiles,
        goalSupported,
        runGoalCommand,
        sendComposerText,
        threadId,
      ]
    );

    // Pull a queued message back into the composer to edit it (also restores its
    // attached files), removing it from the queue. Only ever touches the unsent
    // draft — the running/sent messages in the thread are untouched. A goal
    // or an amendment comes back in its mode, as its queued row showed it
    // (the owner's call, 2026-10-25); the composer is empty here (↑ and Edit
    // need it so), so no chip of its own is in the way.
    const editQueuedMessage = useCallback((id: number) => {
      const target = queuedMessagesRef.current.find((m) => m.id === id);
      if (!target) return;
      setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
      const goalLead = previewLead(target.text, {
        skills: null,
        goals: goalSupportedRef.current === true,
      });
      const mode: GoalMode | null =
        goalLead.chip?.kind === "goal" || goalLead.chip?.kind === "amend"
          ? goalLead.chip.kind
          : null;
      const text = mode
        ? GOAL_LEADS[mode] + target.text.slice(goalLead.lead.length)
        : target.text;
      setGoalMode(mode);
      setInput(text);
      setPendingFiles(target.files);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(text.length, text.length);
        }
      });
    }, []);

    // "Steer": prioritize this instruction without interrupting the
    // active run. It remains in our visible queue and drains in the next idle
    // window, which preserves the same non-interrupting contract.
    const steerQueuedMessage = useCallback((id: number) => {
      setQueuedMessages((messages) => {
        const target = messages.find((message) => message.id === id);
        if (!target || messages[0]?.id === id) return messages;
        return [target, ...messages.filter((message) => message.id !== id)];
      });
      toast.info(
        "This message will run next without interrupting the current turn."
      );
    }, []);

    const moveQueuedMessage = useCallback((id: number, direction: -1 | 1) => {
      setQueuedMessages((messages) => {
        const from = messages.findIndex((message) => message.id === id);
        const to = from + direction;
        if (from < 0 || to < 0 || to >= messages.length) return messages;
        const next = [...messages];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    }, []);

    const dropQueuedMessage = useCallback((targetId: number) => {
      const sourceId = draggedQueuedMessageIdRef.current;
      draggedQueuedMessageIdRef.current = null;
      if (sourceId === null || sourceId === targetId) return;
      setQueuedMessages((messages) => {
        const from = messages.findIndex((message) => message.id === sourceId);
        const to = messages.findIndex((message) => message.id === targetId);
        if (from < 0 || to < 0) return messages;
        const next = [...messages];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
    }, []);

    const removeQueuedMessage = useCallback((id: number) => {
      setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
    }, []);

    const clearQueuedMessages = useCallback(() => {
      setQueuedMessages([]);
    }, []);

    // The chip: the composer holds one string, and a chip stands for its
    // start (the skill its first word pins, or goal mode's words); the box
    // shows the rest.
    const commandWords = goalSupported === false ? MODEL_ONLY : COMMAND_WORDS;
    const chipOptions = {
      skills: knownSkills,
      goalMode: activeGoalMode,
      commands: new Set(commandWords),
    };
    // A change typed or pasted before the skill names arrived gets the
    // one-skill rule once they do, if the box still holds it (a hand-back
    // meanwhile keeps its text).
    const [unsorted, setUnsorted] = useState<string | null>(null);
    // The skills one skill a message took off, said once committed.
    const droppedRef = useRef<string | null>(null);
    if (unsorted !== null && knownSkills !== null) {
      setUnsorted(null);
      if (input === unsorted) {
        const one = oneSkill(input, chipOptions);
        if (one !== input) {
          droppedRef.current = input.slice(0, input.length - one.length);
          setInput(one);
        }
      }
    }
    useEffect(() => {
      const dropped = droppedRef.current;
      if (dropped === null) return;
      droppedRef.current = null;
      const names = dropped.trim().split(/\s+/).join(", ");
      toast.info(`A message takes one skill, so ${names} came off.`);
    });
    // A send held for the skill names goes once they arrive, if the box
    // still holds its text (or that text with one skill); anything else
    // typed or brought back meanwhile drops the hold.
    const submitRef = useRef(() => {});
    useLayoutEffect(() => {
      submitRef.current = () => handleSubmit(undefined, { queueIfBusy: true });
    });
    const holdOptions = useRef(chipOptions);
    holdOptions.current = chipOptions;
    useEffect(() => {
      const held = heldRef.current;
      if (knownSkills === null || held === null) return;
      heldRef.current = null;
      toast.dismiss("skills-pending");
      const now = composerStateRef.current.input;
      if (now !== held && now !== oneSkill(held, holdOptions.current)) return;
      submitRef.current();
    }, [knownSkills]);
    const lead = composerLead(input, chipOptions);
    const rest = input.slice(lead.lead.length);
    const chip = lead.chip;

    // A command chosen from a page runs as if typed and sent with Enter:
    // queued while the agent works, the draft left alone. Its typed word is
    // gone by then, so one that can't run says so.
    const runMenuCommand = (text: string) => {
      const notNow = () =>
        toast.info("This chat can't run commands yet. Try again in a moment.");
      if (!canSend || hasPendingInterrupt) {
        notNow();
        return;
      }
      if (isLoading) {
        setQueuedMessages((prev) => [
          ...prev,
          { id: (queueIdRef.current += 1), text, files: [], threadId },
        ]);
        return;
      }
      if (!canRunNow()) {
        notNow();
        return;
      }
      sendComposerText(text, []);
    };

    // Set a goal… / Amend the goal…: the mode's words go ahead of the box's
    // text, and typing goes on after it. A skill's chip comes off (a goal
    // request carries none), and says so.
    const enterGoalMode = (mode: GoalMode) => {
      if (chip?.kind === "skill") {
        foldChip(chip);
        toast.info(`A goal doesn't take skills, so /${chip.name} came off.`);
      }
      const body = rest.trimStart();
      setGoalMode(mode);
      setInput(GOAL_LEADS[mode] + body);
      slash.placeCaret(body.length);
    };

    const runGoalPageAction = (kind: GoalPageActionKind) => {
      if (kind === "show") {
        setGoalDetailsOpen(true);
        return;
      }
      if (kind === "create" || kind === "amend") {
        enterGoalMode(kind === "create" ? "goal" : "amend");
        return;
      }
      runMenuCommand(`/goal ${kind}`);
    };

    // The `/` menu's commands, each a page: the goal's (where goals run) and
    // the model's (everywhere).
    const goalPage: MenuPage | null =
      goalSupported === true
        ? {
            word: "goal",
            label: "Goal",
            icon: "goal",
            description: goalSummary(goal),
            status: goal ? `${goal.objective} · ${goal.status}` : "No goal yet",
            rows: (filter) =>
              goalPageActions(goal)
                .filter((a) => rowMatches(a.label, filter))
                .map(
                  (a): MenuRow => ({
                    id: a.kind,
                    label: a.label,
                    description: a.description,
                    icon: GOAL_ROW_ICONS[a.kind],
                    danger: a.kind === "clear",
                    run: () => runGoalPageAction(a.kind),
                  })
                ),
            empty: (filter) => `Nothing here matches “${filter}”.`,
          }
        : null;
    const modelRowId = (model: string, provider?: string) =>
      `model:${model}|${provider ?? ""}`;
    const currentEntry = modelPageEntries({
      models: pickerModels,
      override: modelOverride,
      defaultEntry: modelRegistry.defaultEntry,
      filter: "",
    }).find((e) => e.current);
    const modelPage: MenuPage = {
      word: "model",
      label: "Model",
      icon: "model",
      description: "Change the model for this chat",
      tail: currentModel?.name,
      status: currentModel
        ? `Current: ${currentModel.name}${modelOverride ? "" : " (default)"}`
        : undefined,
      note: isFallbackModelList
        ? "Showing a curated list: the backend's model registry didn't load."
        : modelRegistryLoading
        ? "Loading the backend's models…"
        : undefined,
      rows: (filter) => {
        const rows: MenuRow[] = modelPageEntries({
          models: pickerModels,
          override: modelOverride,
          defaultEntry: modelRegistry.defaultEntry,
          filter,
        }).map((e) => ({
          id: modelRowId(e.model, e.provider),
          label: e.model,
          description: e.provider,
          tail: e.isDefault ? "default" : undefined,
          icon: e.current ? "check" : null,
          mono: true,
          run: () =>
            void chooseModel({ model: e.model, model_provider: e.provider }),
        }));
        if (modelOverride && !filter.trim()) {
          const fallback = modelRegistry.defaultEntry?.name;
          rows.push({
            id: "reset",
            label: "Reset to default",
            description: fallback
              ? `Back to ${fallback}`
              : "Back to the deployment's default",
            icon: "reset",
            run: () => void resetModel(),
          });
        }
        return rows;
      },
      initial: currentEntry
        ? modelRowId(currentEntry.model, currentEntry.provider)
        : undefined,
      empty: (filter) => `No models match “${filter}”.`,
    };

    // The `/` menu: the commands' pages, and installed skills to pin while a
    // leading `/name` is typed (in the box: after the chip).
    // The box can't be used (an answer is waited for, or the thread is
    // read-only here): nor can the menu, the model pill or a chip.
    const composerLocked = hasPendingInterrupt || binding.kind === "readOnly";
    const slash = useSlashMenu({
      textareaRef,
      value: rest,
      setValue: (next) => setInput(lead.lead + next),
      disabled: composerLocked,
      project: filesProject,
      onBrowse: () => onNavigate?.({ view: "skills" }),
      pages: goalPage ? [goalPage, modelPage] : [modelPage],
      commandWords,
      // In goal mode the box holds the goal: a "/" there is text.
      rootMenu: activeGoalMode === null,
      leadSkill: chip?.kind === "skill" ? chip.name : null,
      // A text that may start with a skill (whitespace ahead of it too)
      // needs the names to show its chip.
      wantSkills: activeGoalMode === null && mayPin(input),
      onSkillsRead: setKnownSkills,
      // One skill a message: a picked one takes the chip's place, and flies
      // in from its row; typing goes on after it.
      onPickSkill: (name, after, from) => {
        setInput(`/${name} ${after}`);
        setFlyFrom({ name, rect: from });
      },
    });
    const slashKeyDown = slash.onKeyDown;
    // The model pill and `/model` open the Model page, on the current model.
    useLayoutEffect(() => {
      openModelPageRef.current = () => {
        textareaRef.current?.focus();
        slash.openPage("model");
      };
      closeMenuRef.current = () => {
        if (slash.menuProps.view.kind === "page") slash.closeMenu();
      };
    });
    const sendLabel =
      activeGoalMode === "goal"
        ? "Set goal"
        : activeGoalMode === "amend"
        ? "Amend goal"
        : "Send";
    const modelPageOpen =
      slash.menuProps.open &&
      slash.menuProps.view.kind === "page" &&
      slash.menuProps.view.page.word === "model";
    // A page took its typed word out of the box: the user is still typing,
    // which holds auto-reports as text in the box does.
    const menuPageOpen =
      slash.menuProps.open && slash.menuProps.view.kind === "page";

    // Auto-report finished background tasks to the main chat, one per idle
    // window (its rules are inside).
    useEffect(() => {
      if (!liveAgentTasks || liveAgentTasks.length === 0) return;
      if (!threadId || !autoNotify) return;
      // One-time migration/baseline: existing terminal tasks predate the setting
      // and must not replay when this feature first appears or is restored.
      if (!isThreadAutoNotifyInitialized(threadId)) {
        initializeThreadAutoNotifyReports(
          threadId,
          liveAgentTasks
            .filter((task) => isTerminalStatus(task.liveStatus))
            .map(asyncTaskReportKey)
        );
        return;
      }
      // Don't fire when: off; the thread is busy (the agent's own turn takes the
      // slot); a report we just sent hasn't started yet; or the USER is composing
      // a query (draft text) — their message has priority, so we hold the queue
      // until the composer is clear. Pending completions stay unreported (= the
      // queue) and drain one per idle window.
      // An interrupt waiting on the user holds reports too: a report is a run
      // with a message, which would drop a goal's pending review.
      if (
        !canSend ||
        isLoading ||
        hasPendingInterrupt ||
        autoFireInFlightRef.current ||
        input.trim() ||
        menuPageOpen
      )
        return;
      // User-queued messages take the idle slot first — hold auto-reports until
      // the user's own queue has drained.
      if (queuedMessages.length > 0) return;
      const reportedKeys = getThreadAutoNotifyReportedKeys(threadId);
      for (const t of liveAgentTasks) {
        if (!isTerminalStatus(t.liveStatus)) continue;
        const key = asyncTaskReportKey(t);
        if (reportedKeys.has(key)) continue;
        if (
          messages.some(
            (message) =>
              message.type === "human" &&
              asyncUpdateMatchesTask(
                extractStringFromMessageContent(message),
                t
              )
          )
        ) {
          markThreadAutoNotifyReported(threadId, key);
          continue;
        }
        if (!canRunNow()) return;
        autoFireInFlightRef.current = true;
        markThreadAutoNotifyReported(threadId, key);
        // A report of finished background work only completes a grading
        // that waited for it; as a thread turn it would start a new one.
        sendMessage(formatAsyncUpdateMessage(t), { mode: "followup" });
        toast.success(
          `Auto-reported ${agentLabel(t.agent_name)} to the main chat.`
        );
        break; // one per idle window; the rest fire once this turn settles
      }
    }, [
      canSend,
      canRunNow,
      liveAgentTasks,
      autoNotify,
      isLoading,
      hasPendingInterrupt,
      input,
      messages,
      sendMessage,
      threadId,
      queuedMessages,
      menuPageOpen,
    ]);

    // Backspace at the box's start, or the chip's button (Escape too, for
    // goal mode): the chip goes (and folds away), the text after it stays.
    const removeChip = () => {
      if (!chip) return;
      foldChip(chip);
      if (chip.kind !== "skill") setGoalMode(null);
      setInput(rest);
      textareaRef.current?.focus();
    };

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // The composer is locked only when an interrupt is pending (the textarea
        // is disabled then) — NOT while the agent is busy: typing + Enter queues a
        // follow-up rather than doing nothing.
        if (hasPendingInterrupt) return;
        // Don't submit while an IME is composing (e.g. pressing Enter to pick a
        // Chinese/Japanese/Korean candidate must confirm text, not send).
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // While the `/` menu is open, the arrows, Enter, Tab and Escape are its.
        if (slashKeyDown(e)) return;
        if (e.key === "Escape" && activeGoalMode) {
          e.preventDefault();
          removeChip();
          return;
        }
        if (
          e.key === "Backspace" &&
          chip &&
          e.currentTarget.selectionStart === 0 &&
          e.currentTarget.selectionEnd === 0
        ) {
          e.preventDefault();
          removeChip();
          return;
        }
        // ↑ on an empty composer pulls the most recent queued message back to edit.
        if (
          e.key === "ArrowUp" &&
          input.length === 0 &&
          queuedMessagesRef.current.length > 0
        ) {
          e.preventDefault();
          const queue = queuedMessagesRef.current;
          editQueuedMessage(queue[queue.length - 1].id);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
      },
      // removeChip is this render's (chip, rest): `chip` covers it.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [
        handleSubmit,
        hasPendingInterrupt,
        input,
        chip,
        activeGoalMode,
        editQueuedMessage,
        slashKeyDown,
      ]
    );

    // Pull a previous user message back into the composer to edit/resend it,
    // placing the cursor at the end so the user can keep typing.
    const handleEditMessage = useCallback((content: string) => {
      setInput(content);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(content.length, content.length);
        }
      });
    }, []);

    const handleSuggestedPrompt = useCallback((prompt: string) => {
      setInput(prompt);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, []);

    // Auto-approve: when enabled, approve any pending tool-execution interrupt
    // for the rest of this conversation (each interrupt is handled once,
    // keyed by interruptValueKey; the isLoading gate avoids the SDK-swallowed
    // resume race documented in the hook).
    //
    // The deployment's own policy is asked first (`POST /api/policy`): it knows
    // `shell_allow_list`, which the client-side policy cannot see, so an
    // allow-listed command resumes without a prompt even with auto-approve off —
    // exactly as in the TUI. Older deployments have no such route and fall back
    // to the local policy.
    const deployment = useDeployment();
    const approvalPolicy = useApprovalPolicy({
      interrupt,
      deploymentUrl: deployment.deploymentUrl,
      apiKey: deployment.apiKey,
    });
    useAutoApproveInterrupt({
      autoApprove,
      // Nothing is approved for a thread that can't run here; the interrupt
      // is not marked handled either, so it fires once the thread can.
      interrupt: canSend ? interrupt : undefined,
      resumeInterrupt,
      isLoading,
      resetKey: threadId,
      policy: approvalPolicy,
      canResumeNow: canRunNow,
    });

    // ask_user: the agent is asking the user structured questions.
    const askUserQuestions = useMemo<AskUserQuestion[] | null>(() => {
      const value = interrupt?.value as
        | { type?: string; questions?: AskUserQuestion[] }
        | undefined;
      if (value?.type === "ask_user" && Array.isArray(value.questions)) {
        return value.questions;
      }
      return null;
    }, [interrupt]);

    const handleAskUserSubmit = useCallback(
      (answers: string[]) => {
        resumeInterrupt({ status: "answered", answers });
      },
      [resumeInterrupt]
    );

    const handleAskUserCancel = useCallback(() => {
      resumeInterrupt({ status: "cancelled" });
    }, [resumeInterrupt]);

    // Ordered list of pending tool-approval requests from the interrupt. We hand
    // ChatMessage the ORDER (not a name-keyed map) so two calls to the same tool
    // in one turn (e.g. two `execute`) each bind to their OWN request/args instead
    // of both collapsing onto the last one. `Array.isArray` guards a malformed
    // payload — a non-array `action_requests` here would otherwise throw and blank
    // the whole page.
    const actionRequests: ActionRequest[] = useMemo(() => {
      const raw =
        interrupt?.value && (interrupt.value as any)["action_requests"];
      return Array.isArray(raw) ? (raw as ActionRequest[]) : [];
    }, [interrupt]);

    const interruptId = useMemo(() => interruptIdOf(interrupt), [interrupt]);

    // True while the policy is being asked or the interrupt will resume on its
    // own — the cards stay collapsed instead of flashing open for a moment.
    const approvalAutoResolves =
      actionRequests.length > 0 &&
      (approvalPolicy.checking ||
        resolveApprovalDecisions(
          actionRequests as Parameters<typeof resolveApprovalDecisions>[0],
          approvalPolicy.decisions,
          autoApprove
        ) !== null);

    const resumeToolApproval = useCallback(
      (value: any): boolean =>
        resumeInterrupt(buildToolApprovalResume(interruptId, value)),
      [resumeInterrupt, interruptId]
    );

    // TODO: can we make this part of the hook?
    const processedMessages = useMemo(() => {
      /*
     1. Loop through all messages
     2. For each AI message, add the AI message, and any tool calls to the messageMap
     3. For each tool message, find the corresponding tool call in the messageMap and update the status and output
    */
      const messageMap = new Map<
        string,
        { message: Message; toolCalls: ToolCall[] }
      >();
      // Sub-agent (subgraph) messages stream in alongside the main conversation
      // when streamSubgraphs is on. They carry a NESTED langgraph_checkpoint_ns
      // ("tools:<id>|…") while the main agent's own messages are single-segment.
      // Keep them OUT of the main flow — they render under each sub-agent block's
      // "Steps" instead. (streamMetadata is live-only; once complete these messages
      // aren't in thread state anyway.)
      const seenAsyncUpdates = new Set<string>();
      const visibleMessages = messages.filter((message: Message) => {
        // Humans are always user-typed (or our injected async-update pills) —
        // never sub-agent noise. Run their checks first so a stale subgraph
        // namespace on a previous-run human (left over in stream metadata)
        // can't silently drop the original prompt.
        if (message.type === "human") {
          const key = asyncUpdateMessageKey(
            extractStringFromMessageContent(message)
          );
          if (!key) return true;
          if (seenAsyncUpdates.has(key)) return false;
          seenAsyncUpdates.add(key);
          return true;
        }
        const meta = stream.getMessagesMetadata(message)?.streamMetadata;
        const ns = meta?.["langgraph_checkpoint_ns"];
        if (typeof ns === "string" && ns.includes("|")) return false;
        // The conversation-compaction summary is generated by a SEPARATE LLM
        // call (its own "Context Extraction Assistant" system prompt, like the
        // tool-selector). Its output transiently leaks into the raw stream as an
        // AI message (## SESSION INTENT / ## SUMMARY / …) then vanishes — it is
        // never persisted in `messages`. Drop it here; the stable summary is
        // surfaced from `_summarization_event` as a collapsible block instead.
        if (isSummarizationMessage(message)) return false;
        return true;
      });
      const completedToolCallIds = new Set<string>();
      for (const message of visibleMessages) {
        if (message.type !== "tool") continue;
        const toolCallId = message.tool_call_id;
        if (toolCallId) completedToolCallIds.add(toolCallId);
      }
      const pendingActionCounts = new Map<string, number>();
      for (const ar of actionRequests) {
        pendingActionCounts.set(
          ar.name,
          (pendingActionCounts.get(ar.name) ?? 0) + 1
        );
      }
      // A tool call can only still get a result in the latest turn. Once a later
      // human message exists the user has moved on and nothing will answer an
      // earlier call — whatever the current run is doing.
      let lastHumanIndex = -1;
      visibleMessages.forEach((message: Message, index: number) => {
        if (message.type === "human") lastHumanIndex = index;
      });
      visibleMessages.forEach((message: Message, messageIndex: number) => {
        const inLatestTurn = messageIndex > lastHumanIndex;
        if (message.type === "ai") {
          // Collapse duplicate tool_call ids within a single AI message before
          // they reach the render. LangChain's streaming merge can leave the
          // same tool_call twice (the duplicated-SSE-chunk artifact behind the
          // "stopstop" finish_reason handling), and aborting a run mid-tool-call
          // makes it more likely. Downstream keys derive from `toolCall.id`
          // (ChatMessage tool grid + subAgents), so a repeat throws React's
          // "two children with the same key" and duplicates the box. Only real
          // string-id collisions collapse; id-less calls get unique fallbacks
          // below and must be kept. The same merge can also split a call's data
          // across the copies, so a dropped duplicate donates its args/name to
          // the kept copy instead of losing them (an args-less `task` survivor
          // would otherwise vanish from the render entirely).
          const seenToolCalls = new Map<
            string,
            ReturnType<typeof getMessageToolCalls>[number]
          >();
          const toolCallsWithStatus = getMessageToolCalls(message)
            // Fallback keys for id-less calls use the pre-filter index so that
            // collapsing a duplicate (or the transient selector call below)
            // never renumbers — and remounts — the boxes after it.
            .map((toolCall, sourceIndex) => ({ toolCall, sourceIndex }))
            .filter(({ toolCall }) => {
              if (typeof toolCall.id !== "string" || !toolCall.id) return true;
              const kept = seenToolCalls.get(toolCall.id);
              if (kept) {
                if (
                  Object.keys(kept.args).length === 0 &&
                  Object.keys(toolCall.args).length > 0
                ) {
                  kept.args = toolCall.args;
                }
                if (!kept.name && toolCall.name) kept.name = toolCall.name;
                return false;
              }
              seenToolCalls.set(toolCall.id, toolCall);
              return true;
            })
            // The auxiliary tool-selector's internal `ToolSelectionResponse` call
            // has no result and isn't HITL-gated. Surface it only as a transient
            // spinner WHILE the run is actively selecting; hide it once the run
            // pauses on an interrupt or settles. Otherwise the execute approval's
            // "interrupted" icon leaks onto it (it never gets a result to clear)
            // and it lingers instead of disappearing.
            .filter(
              ({ toolCall }) =>
                toolCall.name !== "ToolSelectionResponse" ||
                (isLoading && !interrupt)
            )
            .map(({ toolCall, sourceIndex }) => {
              const name = toolCall.name || "unknown";
              const id =
                toolCall.id ||
                `${message.id ?? "ai-message"}-tool-${sourceIndex}-${name}`;
              const pendingCount = pendingActionCounts.get(name) ?? 0;
              // An approval is always for the turn that is running, so an
              // unanswered call left in an earlier turn cannot claim it.
              const hasPendingAction =
                pendingCount > 0 &&
                inLatestTurn &&
                !completedToolCallIds.has(id);
              if (hasPendingAction) {
                pendingActionCounts.set(name, pendingCount - 1);
              }
              return {
                id,
                name,
                args: toolCall.args,
                // The selector call only survives the filter above while the run is
                // actively selecting (!interrupt), so this resolves to a spinner for
                // it without a special case.
                // No result and no approval pending: still running — unless
                // the run is over, in which case nothing will ever answer it
                // and a spinner would turn forever.
                status: hasPendingAction
                  ? "interrupted"
                  : runSettled || !inLatestTurn
                  ? "stopped"
                  : ("pending" as const),
              } as ToolCall;
            });
          messageMap.set(message.id!, {
            message,
            toolCalls: toolCallsWithStatus,
          });
        } else if (message.type === "tool") {
          const toolCallId = message.tool_call_id;
          if (!toolCallId) {
            return;
          }
          for (const [, data] of messageMap.entries()) {
            const toolCallIndex = data.toolCalls.findIndex(
              (tc: ToolCall) => tc.id === toolCallId
            );
            if (toolCallIndex === -1) {
              continue;
            }
            data.toolCalls[toolCallIndex] = {
              ...data.toolCalls[toolCallIndex],
              // The backend marks a failed tool (or a rejected approval)
              // with status "error" on the tool message.
              status:
                message.status === "error"
                  ? ("error" as const)
                  : ("completed" as const),
              result: extractStringFromMessageContent(message),
            };
            break;
          }
        } else if (message.type === "human") {
          messageMap.set(message.id!, {
            message,
            toolCalls: [],
          });
        }
      });
      const processedArray = Array.from(messageMap.values());
      return processedArray.map((data, index) => {
        const prevMessage =
          index > 0 ? processedArray[index - 1].message : null;
        return {
          ...data,
          showAvatar: data.message.type !== prevMessage?.type,
          pinnedSkills:
            data.message.type === "human" &&
            pinnedSkillName(data.message) === null
              ? pinnedAfter(processedArray, index)
              : NO_PINS,
        };
      });
    }, [messages, actionRequests, interrupt, isLoading, runSettled, stream]);

    const hasWorkflows = useMemo(
      () =>
        Object.values(dynamicWorkflows).some((e) => e.dispatches.length > 0),
      [dynamicWorkflows]
    );

    // UI preference: auto-collapse completed agent-action groups. The user can
    // turn this off under Settings → This browser; default is on.
    const { value: collapseAgentActions } = useCollapseAgentActions();

    // Detect whether an AI message has any actual rendered text content (as
    // opposed to being pure tool-call carriage). Tool-only AI messages are what
    // the ActionGroup wraps; AI messages with text (the assistant's "answer")
    // stay outside the fold so the user always sees it without expanding.
    const aiHasTextContent = (message: Message): boolean => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content.trim().length > 0;
      if (Array.isArray(content)) {
        for (const part of content) {
          const t = (part as { text?: unknown })?.text;
          if (typeof t === "string" && t.trim().length > 0) return true;
        }
      }
      return false;
    };

    // Group consecutive tool-only AI entries into a single foldable action
    // block. Anything else (human messages, AI messages with text) is rendered
    // as before. Reuses the same ProcessedMessage shape — the ActionGroup is
    // pure presentation, no data transformation beyond grouping.
    type RenderedItem =
      | { kind: "message"; data: (typeof processedMessages)[number] }
      | { kind: "action-group"; items: GroupedActionItem[] };
    const renderedItems = useMemo<RenderedItem[]>(() => {
      const out: RenderedItem[] = [];
      for (const entry of processedMessages) {
        const isToolOnly =
          entry.message.type === "ai" &&
          entry.toolCalls.length > 0 &&
          !aiHasTextContent(entry.message);
        if (isToolOnly) {
          const last = out[out.length - 1];
          if (last?.kind === "action-group") {
            last.items.push(entry);
          } else {
            out.push({ kind: "action-group", items: [entry] });
          }
        } else {
          out.push({ kind: "message", data: entry });
        }
      }
      return out;
    }, [processedMessages]);

    const lastMessageId =
      processedMessages.length > 0
        ? processedMessages[processedMessages.length - 1].message.id
        : undefined;

    // Where to anchor the "Conversation compacted" block. The event's
    // cutoffIndex points into the raw `messages` array (messages[0:cutoff] were
    // summarized); we render the block right before the first message AFTER the
    // cutoff so it reads as "everything above was folded into this summary". If
    // that boundary message isn't in the rendered list (e.g. cutoff past the
    // end), fall back to appending the block after the transcript.
    const compactionAnchorId = useMemo(() => {
      if (!summarizationEvent) return null;
      const processedIds = new Set(processedMessages.map((d) => d.message.id));
      // Anchor before the first STILL-VISIBLE message at or after the cutoff, so
      // a filtered boundary message (a tool result, or the transient summary
      // leak itself) doesn't bump the block to the very end of the transcript.
      for (let i = summarizationEvent.cutoffIndex; i < messages.length; i++) {
        const id = messages[i]?.id;
        if (id != null && processedIds.has(id)) return id;
      }
      return null;
    }, [summarizationEvent, messages, processedMessages]);

    const groupedTodos = {
      in_progress: todos.filter((t) => t.status === "in_progress"),
      pending: todos.filter((t) => t.status === "pending"),
      completed: todos.filter((t) => t.status === "completed"),
    };

    const hasTasks = todos.length > 0;
    const hasFiles = Object.keys(files).length > 0;

    const [submittedActionRequestKeys, setSubmittedActionRequestKeys] =
      useState<Set<string>>(() => new Set());
    useEffect(() => {
      if (actionRequests.length === 0) {
        setSubmittedActionRequestKeys(new Set());
      }
    }, [actionRequests.length]);
    const markActionRequestSubmitted = useCallback((key: string) => {
      setSubmittedActionRequestKeys((current) => {
        const next = new Set(current);
        next.add(key);
        return next;
      });
    }, []);

    const reviewConfigsMap: Map<string, ReviewConfig> | null = useMemo(() => {
      const reviewConfigs =
        interrupt?.value && (interrupt.value as any)["review_configs"];
      if (!Array.isArray(reviewConfigs)) return new Map<string, ReviewConfig>();
      const entries: Array<readonly [string, ReviewConfig]> = [];
      for (const rc of reviewConfigs as ReviewConfig[]) {
        const actionName = rc.actionName ?? rc.action_name;
        if (!actionName) continue;
        entries.push([
          actionName,
          {
            actionName,
            allowedDecisions: rc.allowedDecisions ?? rc.allowed_decisions,
          },
        ]);
      }
      return new Map<string, ReviewConfig>(entries);
    }, [interrupt]);

    const lastAiToolCalls = useMemo(() => {
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        const entry = processedMessages[i];
        if (entry.message.type === "ai") return entry.toolCalls;
      }
      return [] as ToolCall[];
    }, [processedMessages]);

    // Anything short of a full binding goes to the fallback as a whole (see
    // `approvalSurface`); the inline cards then get no requests, so a request
    // is never offered — or waited on — in two places at once.
    const hasUnboundActionRequests = useMemo(
      () => approvalSurface(lastAiToolCalls, actionRequests) === "fallback",
      [actionRequests, lastAiToolCalls]
    );
    const inlineActionRequests = hasUnboundActionRequests
      ? NO_ACTION_REQUESTS
      : actionRequests;

    const subAgentRequester = useMemo(() => {
      const types = new Set(
        lastAiToolCalls
          .filter(
            (tc) =>
              tc.name === "task" &&
              tc.status !== "completed" &&
              tc.status !== "error"
          )
          .map((tc) => taskSubAgentName(tc.args))
          .filter((t): t is string => t !== null)
      );
      return types.size === 1 ? [...types][0] : null;
    }, [lastAiToolCalls]);

    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <Dialog
          open={autoApproveDialogOpen}
          onOpenChange={setAutoApproveDialogOpen}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Enable Auto-approve?</DialogTitle>
              <DialogDescription>
                EvoScientist will run routine tool actions in this research
                without asking. Dangerous shell commands (piping downloads into
                an interpreter or network tool) are auto-rejected, delete is
                auto-approved, and schedule_task always asks first.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <p>
                Auto-approve stays on for this research only and follows it
                across views and reloads. Delete is included; scheduled tasks
                still show an approval card here.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setAutoApproveDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={enableAutoApprove}
                className="bg-amber-600 text-white hover:bg-amber-700"
              >
                Enable Auto-approve
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
          ref={scrollRef}
        >
          <div
            className="mx-auto w-full max-w-[960px] px-4 pb-4 pt-3 sm:px-5"
            ref={contentRef}
          >
            {isThreadLoading ? (
              <div className="flex items-center justify-center p-8">
                <p className="text-muted-foreground">Loading…</p>
              </div>
            ) : (
              <>
                {/* A question waiting in an empty chat (a new chat's goal
                    review) takes the page instead. */}
                {processedMessages.length === 0 &&
                  !isLoading &&
                  !hasPendingInterrupt && (
                    <div className="flex min-h-[42vh] flex-col items-center justify-center px-3 pt-12 text-center sm:pt-16">
                      <h2 className="text-pretty text-lg font-semibold sm:text-xl">
                        Where research evolves
                      </h2>
                      <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                        Your self-evolving lab partner — reads the literature,
                        runs experiments, and remembers what matters.
                      </p>
                      <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
                        {SUGGESTED_PROMPTS.map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            onClick={() => handleSuggestedPrompt(prompt)}
                            className="max-w-full rounded-full border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:border-[var(--color-border)] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                      {onNavigate && onOpenThread && (
                        <ResearchDashboard
                          onNavigate={onNavigate}
                          onOpenThread={onOpenThread}
                        />
                      )}
                    </div>
                  )}
                {renderedItems.map((item, index) => {
                  if (item.kind === "action-group") {
                    // A group is "streaming" when its last item is the last
                    // overall AND the run is in flight — drives the spinner +
                    // auto-collapse-on-settle behavior inside ActionGroup.
                    const groupLastId =
                      item.items[item.items.length - 1].message.id;
                    const isLastGroup = index === renderedItems.length - 1;
                    const groupIsStreaming =
                      isLoading && isLastGroup && groupLastId === lastMessageId;
                    return (
                      <ActionGroup
                        key={`action-group-${item.items[0].message.id}`}
                        items={item.items}
                        isStreaming={groupIsStreaming}
                        defaultCollapsed={collapseAgentActions}
                        isAtBottom={isAtBottom}
                        lastMessageId={lastMessageId}
                        isLoading={isLoading || !canSend}
                        actionRequests={
                          interruptsShown ? inlineActionRequests : []
                        }
                        submittedActionRequestKeys={submittedActionRequestKeys}
                        onActionRequestSubmitted={markActionRequestSubmitted}
                        reviewConfigsMap={reviewConfigsMap}
                        stream={stream}
                        onResumeInterrupt={resumeToolApproval}
                        graphId={threadGraph}
                        onEditMessage={handleEditMessage}
                        autoApprove={autoApprove}
                        approvalAutoResolves={approvalAutoResolves}
                        subAgentSteps={subAgentSteps}
                        ui={ui}
                        compactionAnchorId={compactionAnchorId}
                        summarizationEvent={summarizationEvent ?? null}
                      />
                    );
                  }
                  const data = item.data;
                  const messageUi = ui?.filter(
                    (u: any) => u.metadata?.message_id === data.message.id
                  );
                  const isLastMessage = index === renderedItems.length - 1;
                  const isAssistant = data.message.type !== "human";
                  const showCompactionBefore =
                    compactionAnchorId === data.message.id;
                  return (
                    <React.Fragment key={data.message.id}>
                      {showCompactionBefore && summarizationEvent && (
                        <CompactionSummary
                          content={summarizationEvent.content}
                          summarizedCount={summarizationEvent.cutoffIndex}
                        />
                      )}
                      <ChatMessage
                        message={data.message}
                        toolCalls={data.toolCalls}
                        isLoading={isLoading || !canSend}
                        isStreaming={isLoading && isLastMessage && isAssistant}
                        actionRequests={
                          isLastMessage && interruptsShown
                            ? inlineActionRequests
                            : undefined
                        }
                        submittedActionRequestKeys={submittedActionRequestKeys}
                        onActionRequestSubmitted={markActionRequestSubmitted}
                        reviewConfigsMap={
                          isLastMessage ? reviewConfigsMap : undefined
                        }
                        ui={messageUi}
                        stream={stream}
                        onResumeInterrupt={resumeToolApproval}
                        graphId={threadGraph}
                        onEditMessage={handleEditMessage}
                        autoApprove={autoApprove}
                        approvalAutoResolves={approvalAutoResolves}
                        subAgentSteps={subAgentSteps}
                        pinnedSkills={data.pinnedSkills}
                      />
                    </React.Fragment>
                  );
                })}
                {summarizationEvent && !compactionAnchorId && (
                  <CompactionSummary
                    content={summarizationEvent.content}
                    summarizedCount={summarizationEvent.cutoffIndex}
                  />
                )}
                {hasUnboundActionRequests && interruptsShown && (
                  <InterruptApprovalFallback
                    actionRequests={actionRequests}
                    reviewConfigsMap={reviewConfigsMap ?? new Map()}
                    requestedBy={subAgentRequester}
                    interruptKey={interruptId}
                    onResume={resumeToolApproval}
                    // Deciding by hand while the deployment is still being
                    // asked would race the decision it is about to return.
                    isLoading={isLoading || approvalPolicy.checking || !canSend}
                  />
                )}
                {askUserQuestions && interruptsShown && (
                  <div className="mt-4">
                    <AskUserInterrupt
                      key={`ask-user-${
                        interruptId ?? stringifyUnknown(askUserQuestions, 0)
                      }`}
                      questions={askUserQuestions}
                      onSubmit={handleAskUserSubmit}
                      onCancel={handleAskUserCancel}
                      isLoading={isLoading || !canSend}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="relative flex-shrink-0 bg-background">
          {!isAtBottom && processedMessages.length > 0 && (
            <button
              type="button"
              // A mouse press would move focus here, then lose it on unmount.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                void scrollToBottom();
                // Pressing the button unmounts it. A keyboard or screen-reader
                // press (detail 0) gets the composer; a tap must not open the phone keyboard.
                if (e.detail === 0) {
                  textareaRef.current?.focus({ preventScroll: true });
                }
              }}
              aria-label="Jump to latest message"
              title="Jump to latest message"
              className="absolute bottom-full left-1/2 z-10 mb-3 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:w-11"
            >
              <ArrowDown
                className="h-4 w-4"
                aria-hidden="true"
              />
            </button>
          )}
          {queuedMessages.length > 0 && (
            <div
              aria-label="Queued messages"
              className="relative mx-auto -mb-4 w-[calc(100%-16px)] max-w-[960px] px-2 sm:w-[calc(100%-24px)]"
            >
              <div className="rounded-b-lg rounded-t-2xl border border-border bg-background pb-5 pt-1 shadow-sm">
                {queuedMessages.map((q, index) => {
                  const editBlocked =
                    input.trim().length > 0 || pendingFiles.length > 0;
                  // Its skill or goal as a chip, read as Enter will read it.
                  const preview = previewLead(q.text, {
                    skills: knownSkills,
                    goals: goalSupported === true,
                    commands: new Set(commandWords),
                  });
                  return (
                    <div
                      key={q.id}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => dropQueuedMessage(q.id)}
                      className="relative flex min-h-11 items-start gap-1.5 px-2 py-2 text-sm sm:gap-2 sm:px-3"
                    >
                      <button
                        type="button"
                        draggable
                        onDragStart={(event) => {
                          draggedQueuedMessageIdRef.current = q.id;
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(
                            "text/plain",
                            String(q.id)
                          );
                        }}
                        onDragEnd={() => {
                          draggedQueuedMessageIdRef.current = null;
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp" && index > 0) {
                            event.preventDefault();
                            moveQueuedMessage(q.id, -1);
                          }
                          if (
                            event.key === "ArrowDown" &&
                            index < queuedMessages.length - 1
                          ) {
                            event.preventDefault();
                            moveQueuedMessage(q.id, 1);
                          }
                        }}
                        aria-label={`Reorder queued message ${index + 1} of ${
                          queuedMessages.length
                        }`}
                        title="Drag to reorder, or use the arrow keys"
                        className="mt-0.5 inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                      >
                        <GripVertical
                          className="size-3.5"
                          aria-hidden="true"
                        />
                      </button>
                      <CornerDownRight
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="line-clamp-2 whitespace-pre-wrap break-words pt-0.5 text-foreground">
                          {preview.chip && (
                            <>
                              <span className="sr-only">{preview.lead}</span>
                              {/* A selection copies the text as sent. */}
                              <span
                                aria-hidden="true"
                                className="select-none"
                              >
                                <ComposerChip
                                  chip={preview.chip}
                                  className="mr-1.5 h-5 align-middle"
                                />
                              </span>
                            </>
                          )}
                          {q.text.slice(preview.lead.length)}
                        </span>
                        {q.files.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Paperclip
                              className="size-3 shrink-0"
                              aria-hidden="true"
                            />
                            {q.files.length} file
                            {q.files.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => steerQueuedMessage(q.id)}
                          aria-label="Steer with this message next"
                          title="Submit next without interrupting the current turn"
                          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <CornerDownRight
                            className="size-3.5"
                            aria-hidden="true"
                          />
                          <span className="hidden sm:inline">Steer</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => removeQueuedMessage(q.id)}
                          aria-label="Remove queued message"
                          title="Remove from queue"
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Trash2
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        </button>
                        <details
                          className="group/menu relative"
                          onBlur={(event) => {
                            if (
                              !event.currentTarget.contains(event.relatedTarget)
                            ) {
                              event.currentTarget.removeAttribute("open");
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.currentTarget.removeAttribute("open");
                              event.currentTarget
                                .querySelector("summary")
                                ?.focus();
                            }
                          }}
                        >
                          <summary
                            aria-label="More queued message actions"
                            title="More actions"
                            className="inline-flex size-7 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
                          >
                            <Ellipsis
                              className="size-4"
                              aria-hidden="true"
                            />
                          </summary>
                          <div className="absolute right-0 top-8 z-30 min-w-40 rounded-xl border border-border bg-background p-1.5 shadow-lg">
                            <button
                              type="button"
                              onClick={() => editQueuedMessage(q.id)}
                              disabled={editBlocked}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Pencil
                                className="size-4"
                                aria-hidden="true"
                              />
                              Edit message
                            </button>
                            <button
                              type="button"
                              onClick={clearQueuedMessages}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <ListX
                                className="size-4"
                                aria-hidden="true"
                              />
                              Close queue
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div
            ref={composerRef}
            data-mode={activeGoalMode ?? undefined}
            className={cn(
              "relative z-10 mx-auto mb-2 flex w-[calc(100%-16px)] max-w-[960px] flex-shrink-0 flex-col overflow-hidden rounded-xl border bg-background transition-[color,background-color,border-color,box-shadow] duration-200 ease-in-out sm:mb-4 sm:w-[calc(100%-24px)]",
              "focus-within:ring-2 focus-within:ring-ring",
              activeGoalMode
                ? "border-[var(--brand)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand)_16%,transparent)]"
                : "border-border"
            )}
          >
            {
              <div className="flex max-h-60 flex-col overflow-y-auto border-b border-border bg-sidebar empty:hidden sm:max-h-72">
                {!metaOpen && (
                  <>
                    <DynamicWorkflowTrigger
                      workflows={dynamicWorkflows}
                      expanded={false}
                      onClick={() =>
                        setMetaOpen((prev) =>
                          prev === "workflow" ? null : "workflow"
                        )
                      }
                    />
                    {(() => {
                      const activeTask = todos.find(
                        (t) => t.status === "in_progress"
                      );

                      const totalTasks = todos.length;
                      const remainingTasks =
                        totalTasks - groupedTodos.pending.length;
                      const isCompleted = totalTasks === remainingTasks;

                      const tasksTrigger = (() => {
                        if (!hasTasks) return null;
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setMetaOpen((prev) =>
                                prev === "tasks" ? null : "tasks"
                              )
                            }
                            className="grid w-full cursor-pointer grid-cols-[auto_auto_1fr] items-center gap-2.5 px-3 py-2.5 text-left sm:px-4"
                            aria-expanded={metaOpen === "tasks"}
                          >
                            {(() => {
                              if (isCompleted) {
                                return [
                                  <CheckCircle
                                    key="icon"
                                    size={16}
                                    className="text-[var(--color-success)]"
                                  />,
                                  <span
                                    key="label"
                                    className="ml-[1px] min-w-0 truncate text-sm"
                                  >
                                    All tasks completed
                                  </span>,
                                ];
                              }

                              if (activeTask != null) {
                                return [
                                  <div key="icon">
                                    {getStatusIcon(activeTask.status)}
                                  </div>,
                                  <span
                                    key="label"
                                    className="ml-[1px] min-w-0 truncate text-sm"
                                  >
                                    Task{" "}
                                    {totalTasks - groupedTodos.pending.length}{" "}
                                    of {totalTasks}
                                  </span>,
                                  <span
                                    key="content"
                                    className="min-w-0 gap-2 truncate text-sm text-muted-foreground"
                                  >
                                    {activeTask.content}
                                  </span>,
                                ];
                              }

                              return [
                                <Circle
                                  key="icon"
                                  size={16}
                                  className="text-[var(--color-text-tertiary)]"
                                />,
                                <span
                                  key="label"
                                  className="ml-[1px] min-w-0 truncate text-sm"
                                >
                                  Task{" "}
                                  {totalTasks - groupedTodos.pending.length} of{" "}
                                  {totalTasks}
                                </span>,
                              ];
                            })()}
                          </button>
                        );
                      })();

                      const filesTrigger = (() => {
                        if (!hasFiles) return null;
                        return (
                          <button
                            type="button"
                            onClick={() =>
                              setMetaOpen((prev) =>
                                prev === "files" ? null : "files"
                              )
                            }
                            className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm sm:px-4"
                            aria-expanded={metaOpen === "files"}
                          >
                            <FileIcon size={16} />
                            Files (State)
                            <span className="h-4 min-w-4 rounded-full bg-[var(--brand-solid)] px-0.5 text-center text-[10px] leading-[16px] text-[var(--brand-foreground)]">
                              {Object.keys(files).length}
                            </span>
                          </button>
                        );
                      })();

                      if (!hasTasks && !hasFiles) return null;

                      return (
                        <div className="flex items-center">
                          <div className="min-w-0 flex-1">{tasksTrigger}</div>
                          {filesTrigger}
                        </div>
                      );
                    })()}
                  </>
                )}

                {metaOpen && (
                  <>
                    <div className="sticky top-0 flex items-stretch bg-sidebar text-sm">
                      {hasTasks && (
                        <button
                          type="button"
                          className="py-2.5 pr-4 first:pl-3 aria-expanded:font-semibold sm:first:pl-4"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "tasks" ? null : "tasks"
                            )
                          }
                          aria-expanded={metaOpen === "tasks"}
                        >
                          Tasks
                        </button>
                      )}
                      {hasFiles && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 py-2.5 pr-4 first:pl-3 aria-expanded:font-semibold sm:first:pl-4"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "files" ? null : "files"
                            )
                          }
                          aria-expanded={metaOpen === "files"}
                        >
                          Files (State)
                          <span className="h-4 min-w-4 rounded-full bg-[var(--brand-solid)] px-0.5 text-center text-[10px] leading-[16px] text-[var(--brand-foreground)]">
                            {Object.keys(files).length}
                          </span>
                        </button>
                      )}
                      {hasWorkflows && (
                        <button
                          type="button"
                          className="py-2.5 pr-4 first:pl-3 aria-expanded:font-semibold sm:first:pl-4"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "workflow" ? null : "workflow"
                            )
                          }
                          aria-expanded={metaOpen === "workflow"}
                        >
                          Workflow
                        </button>
                      )}
                      <button
                        aria-label="Close"
                        className="flex-1"
                        onClick={() => setMetaOpen(null)}
                      />
                    </div>
                    <div
                      ref={tasksContainerRef}
                      className="px-3 sm:px-4"
                    >
                      {metaOpen === "tasks" &&
                        Object.entries(groupedTodos)
                          .filter(([_, todos]) => todos.length > 0)
                          .map(([status, todos]) => (
                            <div
                              key={status}
                              className="mb-4"
                            >
                              <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
                                {
                                  {
                                    pending: "Pending",
                                    in_progress: "In Progress",
                                    completed: "Completed",
                                  }[status]
                                }
                              </h3>
                              <div className="grid grid-cols-[auto_1fr] gap-3 rounded-sm p-1 pl-0 text-sm">
                                {todos.map((todo, index) => (
                                  <Fragment
                                    key={`${status}_${todo.id}_${index}`}
                                  >
                                    {getStatusIcon(todo.status, "mt-0.5")}
                                    <span className="break-words text-inherit">
                                      {todo.content}
                                    </span>
                                  </Fragment>
                                ))}
                              </div>
                            </div>
                          ))}

                      {metaOpen === "files" && (
                        <div className="mb-6">
                          <FilesPopover files={files} />
                        </div>
                      )}

                      {metaOpen === "workflow" && (
                        <DynamicWorkflowPanel
                          workflows={dynamicWorkflows}
                          expertNames={expertNames}
                        />
                      )}
                    </div>
                  </>
                )}
              </div>
            }
            {autoApprove && (
              <div
                aria-live="polite"
                className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
              >
                <span className="flex items-center gap-1.5">
                  <TriangleAlert
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  Tool actions auto-run, including delete. Dangerous commands
                  are blocked; scheduled tasks still ask.
                </span>
                <button
                  type="button"
                  onClick={turnOffAutoApprove}
                  aria-label="Turn off auto-approve"
                  className="shrink-0 rounded px-2 py-1 font-semibold transition-colors hover:bg-amber-200 focus-visible:ring-2 focus-visible:ring-amber-700 dark:hover:bg-amber-900"
                >
                  Turn Off
                </button>
              </div>
            )}
            {(currentModel ||
              runningAgents > 0 ||
              installedExperts.length > 0) && (
              <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                {currentModel && (
                  <button
                    type="button"
                    // Keep the composer's focus: the page opens over it, and
                    // a second click closes it.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() =>
                      modelPageOpen
                        ? slash.closeMenu()
                        : openModelPageRef.current()
                    }
                    disabled={composerLocked}
                    aria-haspopup="listbox"
                    aria-expanded={modelPageOpen}
                    title="Click to change model for this chat"
                    aria-label="Change model for this chat"
                    className="-mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <Sparkles
                      className="size-3.5 shrink-0 text-[var(--brand)]"
                      aria-hidden="true"
                    />
                    <SwapText
                      text={currentModel.name}
                      className="truncate font-medium text-foreground"
                    />
                    {currentModel.provider && (
                      <SwapText
                        text={`· ${currentModel.provider}`}
                        className="hidden shrink-0 sm:inline"
                      />
                    )}
                  </button>
                )}
                <ExpertsPill
                  teams={installedExperts}
                  onManage={() => onNavigate?.({ view: "experts" })}
                />
                <GoalPill
                  goal={goal}
                  busy={goalBusy}
                  verdict={rubricVerdict}
                  open={goalDetailsOpen}
                  onOpenChange={setGoalDetailsOpen}
                />
                {runningAgents > 0 && (
                  <button
                    type="button"
                    onClick={onShowAgents}
                    title={`${runningAgents} background agent${
                      runningAgents === 1 ? "" : "s"
                    } running — click to view`}
                    aria-label={`${runningAgents} background agent${
                      runningAgents === 1 ? "" : "s"
                    } running — view`}
                    className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-[var(--brand)] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className="size-2 animate-pulse rounded-full bg-[var(--color-warning)]"
                      aria-hidden="true"
                    />
                    {runningAgents} agent{runningAgents === 1 ? "" : "s"}
                  </button>
                )}
              </div>
            )}
            <form
              onSubmit={handleSubmit}
              className="mobile-composer flex flex-col"
            >
              {pendingFiles.length > 0 && (
                <div
                  aria-label="Attached files"
                  className="flex flex-wrap gap-2 border-b border-border px-3 py-2"
                >
                  {pendingFiles.map((file) => (
                    <span
                      key={file.path}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
                    >
                      <FileIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span
                        className="max-w-48 truncate"
                        title={file.path}
                      >
                        {file.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removePendingFile(file.path)}
                        aria-label={`Remove ${file.name} from this message`}
                        title={`Remove ${file.name} from this message`}
                        className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X
                          className="size-3.5"
                          aria-hidden="true"
                        />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* With a chip the row holds the box's left padding and the chip
                  keeps its gap on its right, so a chip folding away (gap
                  included) leaves the text where it stays; without one the
                  padding is the box's (pressable). A press on the row itself
                  focuses the box. */}
              <div
                onMouseDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  e.preventDefault();
                  textareaRef.current?.focus();
                }}
                className={cn(
                  "flex min-w-0 cursor-text items-start transition-colors duration-200",
                  (chip || leavingChip) && "pl-3.5 sm:pl-4",
                  activeGoalMode &&
                    "bg-[color-mix(in_srgb,var(--brand-soft)_70%,transparent)]"
                )}
              >
                {leavingChip && (
                  <ComposerChip
                    key={leavingChip.seq}
                    chip={leavingChip.chip}
                    leaving
                    onLeft={() => setLeavingChip(null)}
                    className="mr-2 mt-3"
                  />
                )}
                {chip && (
                  <ComposerChip
                    key={chip.kind === "skill" ? chip.name : chip.kind}
                    chip={chip}
                    onRemove={removeChip}
                    disabled={composerLocked}
                    flyFrom={
                      chip.kind === "skill" &&
                      flyFrom?.name === chip.name &&
                      flyFrom !== flown.current
                        ? flyFrom.rect
                        : null
                    }
                    className="mr-2 mt-3"
                  />
                )}
                {chip && (
                  <span
                    id={chipHintId}
                    className="sr-only"
                  >
                    {chip.kind === "skill"
                      ? `Skill ${chip.name} pinned. Backspace at the start removes it.`
                      : chip.kind === "goal"
                      ? "Setting a goal: what you write is the goal. Escape leaves goal mode."
                      : "Amending the goal: what you write is the change. Escape leaves amend mode."}
                  </span>
                )}
                <textarea
                  ref={textareaRef}
                  value={rest}
                  onChange={(e) => {
                    const next = e.target.value;
                    // A skill typed or pasted at the box's start takes the
                    // chip's place: one skill a message, so of several at
                    // once the last. The caret stays where the typing was.
                    const typedSkill =
                      !activeGoalMode &&
                      composerLead(rest, chipOptions).chip === null &&
                      composerLead(next, chipOptions).chip !== null;
                    if (!typedSkill) {
                      const full = lead.lead + next;
                      setInput(full);
                      setUnsorted(
                        knownSkills === null && mayPin(full) ? full : null
                      );
                      slash.onChange(e);
                      return;
                    }
                    const full = oneSkill(next, chipOptions);
                    const box = full.slice(
                      composerLead(full, chipOptions).lead.length
                    );
                    // One skill a message: of several, what came off is said.
                    if (full !== next) {
                      droppedRef.current = next.slice(
                        0,
                        next.length - full.length
                      );
                    }
                    setInput(full);
                    slash.onChange(e);
                    slash.placeCaret(
                      Math.max(
                        0,
                        (e.target.selectionStart ?? next.length) -
                          (next.length - box.length)
                      )
                    );
                  }}
                  onKeyDown={handleKeyDown}
                  {...slash.textareaProps}
                  aria-describedby={chip ? chipHintId : undefined}
                  aria-label="Message"
                  disabled={composerLocked}
                  placeholder={
                    binding.kind === "readOnly"
                      ? binding.reason
                      : !canSend && projectsRefreshing
                      ? projectsError
                        ? `Can't read the backend's projects (${projectsError}). Retrying…`
                        : "Connecting to the backend…"
                      : hasPendingInterrupt
                      ? "Respond to the request above to continue…"
                      : activeGoalMode === "goal"
                      ? "Describe the goal; its criteria are drafted for you to review…"
                      : activeGoalMode === "amend"
                      ? "What should change in the goal?"
                      : isLoading
                      ? "Queue a follow-up — sends when this turn finishes…"
                      : chip
                      ? "Add your message…"
                      : "Ask EvoScientist anything…"
                  }
                  className={cn(
                    "font-inherit field-sizing-content max-h-[min(30dvh,12rem)] min-h-12 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent pb-2.5 pr-3.5 pt-3 text-sm leading-6 text-primary outline-none placeholder:text-tertiary focus:ring-0 disabled:cursor-not-allowed sm:pr-4",
                    chip || leavingChip ? "pl-0" : "pl-3.5 sm:pl-4"
                  )}
                  rows={1}
                />
              </div>
              <SlashSkillMenu
                {...slash.menuProps}
                anchorRef={composerRef}
              />
              <div className="flex items-center justify-between gap-2 p-2 sm:p-2.5">
                <div className="flex items-center gap-1">
                  <input
                    ref={uploadInputRef}
                    type="file"
                    multiple
                    onChange={handleFilesSelected}
                    disabled={
                      !canSend ||
                      !filesHere ||
                      hasPendingInterrupt ||
                      isUploadingFiles
                    }
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={
                      !canSend ||
                      !filesHere ||
                      hasPendingInterrupt ||
                      isUploadingFiles
                    }
                    aria-label="Upload files to workspace"
                    title="Upload files to workspace (max 50 MB each)"
                    className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Paperclip
                      className="size-4"
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      autoApprove
                        ? turnOffAutoApprove()
                        : setAutoApproveDialogOpen(true)
                    }
                    aria-pressed={autoApprove}
                    aria-label={
                      autoApprove ? "Turn off auto-approve" : "Auto-approve"
                    }
                    title="Auto-approve all tool actions in this conversation"
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                      autoApprove
                        ? "bg-amber-600 text-white hover:bg-amber-700"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <ShieldCheck
                      className="size-3.5"
                      aria-hidden="true"
                    />
                    <span className="hidden min-[360px]:inline">
                      {autoApprove ? "Auto-approve On" : "Auto-approve"}
                    </span>
                  </button>
                  {onNavigate && folderLabel && (
                    <button
                      type="button"
                      onClick={() => onNavigate({ view: "workspace" })}
                      title={`${workspaceOpen ? "Close" : "Open"} workspace: ${
                        folderLabel.full
                      }`}
                      aria-label={`${
                        workspaceOpen ? "Close" : "Open"
                      } workspace: ${folderLabel.full}`}
                      aria-pressed={Boolean(workspaceOpen)}
                      className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <FolderOpen
                        className="size-3.5 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <span className="hidden max-w-[140px] truncate font-mono sm:inline lg:max-w-[220px]">
                        {folderLabel.name}
                      </span>
                    </button>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type={isLoading ? "button" : "submit"}
                    variant={isLoading ? "destructive" : "default"}
                    onClick={isLoading ? abortRun : handleSubmit}
                    // The composer keeps its focus: a blur would take an
                    // open page's word back into the box before the click.
                    onMouseDown={(e) => e.preventDefault()}
                    disabled={
                      !isLoading &&
                      (submitDisabled || isUploadingFiles || !input.trim())
                    }
                    aria-label={
                      isLoading
                        ? "Stop generating"
                        : activeGoalMode
                        ? sendLabel
                        : "Send message"
                    }
                  >
                    {isLoading ? (
                      <>
                        <Square size={14} />
                        <span className="hidden sm:inline">Stop</span>
                      </>
                    ) : (
                      <>
                        <ArrowUp size={18} />
                        <SwapText
                          text={sendLabel}
                          className="hidden sm:inline"
                        />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }
);

ChatInterface.displayName = "ChatInterface";
