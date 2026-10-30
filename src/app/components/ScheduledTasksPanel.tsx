"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Calendar,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  Clock,
  FlaskConical,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { INPUT_LIKE_TRIGGER, LIST_MAX_HEIGHT } from "@/lib/fieldStyles";
import { cn } from "@/lib/utils";
import { ScheduledTaskActivity } from "@/app/components/ScheduledTaskActivity";
import { useProjects } from "@/providers/ProjectsProvider";
import {
  projectsByAssistant,
  registeredTasks,
  type Project,
} from "@/lib/projects";
import {
  createScheduledTask,
  deleteScheduledTask,
  runScheduledTaskNow,
  scheduledTaskMissing,
  setScheduledTaskEnabled,
  updateScheduledTask,
  upcomingRun,
  useScheduledTasks,
  schedulerTarget,
  useAssistantRecovery,
  useSchedulerGate,
  type ScheduledTask,
} from "@/app/hooks/useScheduledTasks";
import {
  browserTimeZone,
  cronLabel,
  cronToSpec,
  DAY_NAMES,
  DEFAULT_SCHEDULE_SPEC,
  nextRunLabel,
  scheduleLabel,
  specToCron,
  timeZoneLabel,
  validateCronExpression,
  type Frequency,
  type ScheduleSpec,
} from "@/lib/cronUtils";

interface Template {
  icon: LucideIcon;
  label: string;
  description: string;
  name: string;
  prompt: string;
  schedule: string;
}

const TEMPLATES: Template[] = [
  {
    icon: ClipboardList,
    label: "Daily Papers",
    description: "Track new ML papers against your research preferences.",
    name: "Daily Papers",
    prompt:
      "Summarise the latest ML papers from arXiv according to my research preferences with the paper-navigator skill. Focus on papers that are relevant to my current projects, explain why each one matters, and save the summary to ./daily-papers.md in the current workspace.",
    schedule: "0 9 * * *",
  },
  {
    icon: Repeat2,
    label: "Weekly Research Review",
    description:
      "Summarise this week's research progress and future direction.",
    name: "Weekly Research Review",
    prompt:
      "Summarise this week's research progress across my active projects. Highlight key results, decisions, blockers, open questions, and what changed in my understanding. Then propose future research directions and concrete next steps. Save the review to ./weekly-research-review.md in the current workspace.",
    schedule: "0 17 * * 5",
  },
  {
    icon: Activity,
    label: "Weekly Research Plan",
    description: "Draft a Monday plan for the week's research priorities.",
    name: "Weekly Research Plan",
    prompt:
      "Draft this week's research plan based on my active projects, recent progress, project files, and open questions. Prioritise the most important research goals, propose concrete experiments or reading tasks, identify risks, and write a practical schedule for the week. Save the plan to ./weekly-research-plan.md in the current workspace.",
    schedule: "0 8 * * 1",
  },
  {
    icon: FlaskConical,
    label: "Experiment Backlog",
    description: "Convert open questions into testable experiment ideas.",
    name: "Experiment Backlog",
    prompt:
      "Review my active project files, recent research notes, and open questions. Turn the most important unresolved ideas into a prioritised experiment backlog with hypotheses, expected signal, required data or code, estimated effort, and success criteria. Save it to ./experiment-backlog.md in the current workspace.",
    schedule: "0 10 * * 2",
  },
];

function formatAbsoluteDate(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatLongDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCreatedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function taskSearchText(task: ScheduledTask): string {
  return [
    task.name,
    task.prompt,
    task.schedule,
    scheduleLabel(task.schedule, task.timezone),
    task.enabled ? "" : "paused",
    upcomingRun(task) ? formatAbsoluteDate(upcomingRun(task)) : "",
  ]
    .join(" ")
    .toLowerCase();
}

function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    const aRun = upcomingRun(a);
    const bRun = upcomingRun(b);
    const aNext = aRun ? new Date(aRun).getTime() : 0;
    const bNext = bRun ? new Date(bRun).getTime() : 0;
    if (aNext && bNext && aNext !== bNext) return aNext - bNext;
    if (aNext && !bNext) return -1;
    if (!aNext && bNext) return 1;
    return a.name.localeCompare(b.name);
  });
}

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-xs font-medium text-muted-foreground"
    >
      {children}
    </label>
  );
}

function ScheduleBuilder({
  value,
  onChange,
  error,
  timeZone,
}: {
  value: ScheduleSpec;
  onChange: (s: ScheduleSpec) => void;
  error?: string | null;
  /** The zone the task will be saved in; undefined reads as UTC. */
  timeZone: string | undefined;
}) {
  const set = (patch: Partial<ScheduleSpec>) =>
    onChange({ ...value, ...patch });

  // In-page lists, like the Settings page's (a native <select> opens the
  // system's own popup). In a form Radix also renders a hidden native
  // <select>, which can report "" for a value it has no option for yet; no
  // item has the value "", so that is never a pick.
  const frequencyTriggerClass = cn(INPUT_LIKE_TRIGGER, "sm:min-w-40");
  const dayTriggerClass = cn(INPUT_LIKE_TRIGGER, "sm:w-28");

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(9rem,1fr)_auto_auto_auto_auto] sm:items-center">
        <Select
          value={value.frequency}
          onValueChange={(next) => {
            if (next) set({ frequency: next as Frequency });
          }}
        >
          <SelectTrigger
            aria-label="Schedule frequency"
            className={frequencyTriggerClass}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={LIST_MAX_HEIGHT}>
            <SelectItem value="daily">Every day</SelectItem>
            <SelectItem value="weekly">Every week</SelectItem>
            <SelectItem value="monthly">Every month</SelectItem>
            <SelectItem value="custom">Custom cron</SelectItem>
          </SelectContent>
        </Select>

        {value.frequency !== "custom" && (
          <>
            {value.frequency === "weekly" && (
              <Select
                value={String(value.dayOfWeek)}
                onValueChange={(next) => {
                  if (next) set({ dayOfWeek: Number(next) });
                }}
              >
                <SelectTrigger
                  aria-label="Day of week"
                  className={dayTriggerClass}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={LIST_MAX_HEIGHT}>
                  {DAY_NAMES.map((day, index) => (
                    <SelectItem
                      key={day}
                      value={String(index)}
                    >
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {value.frequency === "monthly" && (
              <Select
                value={String(value.dayOfMonth)}
                onValueChange={(next) => {
                  if (next) set({ dayOfMonth: Number(next) });
                }}
              >
                <SelectTrigger
                  aria-label="Day of month"
                  className={dayTriggerClass}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={LIST_MAX_HEIGHT}>
                  {Array.from({ length: 28 }, (_, index) => index + 1).map(
                    (day) => (
                      <SelectItem
                        key={day}
                        value={String(day)}
                      >
                        Day {day}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            )}

            <span className="hidden text-xs text-muted-foreground sm:block">
              at
            </span>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:col-span-2 sm:w-32">
              <Input
                aria-label="Hour"
                type="number"
                min={0}
                max={23}
                value={value.hour}
                onChange={(e) =>
                  set({ hour: Math.trunc(Number(e.target.value)) })
                }
                className="h-9 text-center font-mono tabular-nums"
              />
              <span className="font-mono text-muted-foreground">:</span>
              <Input
                aria-label="Minute"
                type="number"
                min={0}
                max={59}
                value={value.minute}
                onChange={(e) =>
                  set({ minute: Math.trunc(Number(e.target.value)) })
                }
                className="h-9 text-center font-mono tabular-nums"
              />
            </div>
          </>
        )}
      </div>

      {value.frequency === "custom" && (
        <Input
          type="text"
          value={value.custom}
          onChange={(e) => set({ custom: e.target.value })}
          placeholder="0 9 * * 1-5"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby="schedule-cron-help"
          className="h-9 font-mono text-sm"
        />
      )}

      <div
        id="schedule-cron-help"
        className={cn(
          "flex items-center gap-1.5 text-xs",
          error ? "text-destructive" : "text-muted-foreground"
        )}
      >
        <CalendarClock
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">
          {error ?? scheduleLabel(specToCron(value), timeZone)}
        </span>
      </div>
    </div>
  );
}

interface TemplateButtonProps {
  template: Template;
  onSelect: (template: Template) => void;
  compact?: boolean;
  disabled?: boolean;
}

function TemplateButton({
  template,
  onSelect,
  compact,
  disabled,
}: TemplateButtonProps) {
  const Icon = template.icon;

  return (
    <button
      type="button"
      onClick={() => onSelect(template)}
      disabled={disabled}
      className={cn(
        "hover:border-[var(--brand)]/40 group flex w-full min-w-0 items-start gap-2 rounded-md border border-border bg-[var(--color-surface)] text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        compact ? "px-2.5 py-2" : "px-3 py-2.5"
      )}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-[var(--brand)] group-hover:bg-background">
        <Icon
          className="size-4"
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {template.label}
        </span>
        {!compact && (
          <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {template.description}
          </span>
        )}
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {cronLabel(template.schedule)}
        </span>
      </span>
    </button>
  );
}

interface CreateFormProps {
  initialTemplate?: Template;
  initialTask?: ScheduledTask;
  /** The form's answer came: the task an edit saved, else nothing (a
   *  create, or an edit whose task was deleted elsewhere). */
  onSaved: (task?: ScheduledTask) => void;
  onCancel: () => void;
  /** Whether a save is in flight: the panel locks what would leave it. */
  onBusy: (busy: boolean) => void;
}

function TaskForm({
  initialTemplate,
  initialTask,
  onSaved,
  onCancel,
  onBusy,
}: CreateFormProps) {
  const isEditing = Boolean(initialTask);
  const [name, setName] = useState(
    initialTask?.name ?? initialTemplate?.name ?? ""
  );
  const [prompt, setPrompt] = useState(
    initialTask?.prompt ?? initialTemplate?.prompt ?? ""
  );
  const [spec, setSpec] = useState<ScheduleSpec>(() =>
    initialTask
      ? cronToSpec(initialTask.schedule)
      : initialTemplate
      ? cronToSpec(initialTemplate.schedule)
      : { ...DEFAULT_SCHEDULE_SPEC }
  );
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // A stored schedule the builder reads but spells differently (`09 07 * * *`
  // opens as daily at 07:09 and is written `9 7 * * *`) is kept as stored
  // while the builder still writes what it wrote on opening. Custom cron text
  // is saved as entered (outer spaces trimmed).
  const openedCron = useMemo(
    () => (initialTask ? specToCron(cronToSpec(initialTask.schedule)) : null),
    [initialTask]
  );
  const builtCron = specToCron(spec);
  const cron =
    initialTask && spec.frequency !== "custom" && builtCron === openedCron
      ? initialTask.schedule.trim()
      : builtCron;
  // Whether the Custom cron box holds text to keep: the custom cron the task
  // opened with, or text typed there (an emptied box counts as none).
  // Otherwise switching to Custom cron fills the box with what the form would
  // save: the task's own cron while nothing changed, or the schedule as the
  // builder shows it.
  const keepCustomText = useRef(spec.frequency === "custom");
  const changeSpec = (next: ScheduleSpec) => {
    const wasCustom = spec.frequency === "custom";
    if (
      wasCustom &&
      next.frequency === "custom" &&
      next.custom !== spec.custom
    ) {
      keepCustomText.current = next.custom.trim() !== "";
    }
    setSpec(
      !wasCustom && next.frequency === "custom" && !keepCustomText.current
        ? { ...next, custom: cron }
        : next
    );
  };
  // A stored schedule saves as it is: the backend took it, and it may use what
  // the editor doesn't write, such as a seconds field. Only new text is checked.
  const cronError =
    spec.frequency === "custom" && cron !== initialTask?.schedule.trim()
      ? validateCronExpression(cron)
      : null;
  // An edit keeps the task's time zone. A task stored without one (made before
  // #61, so read as UTC) moves to the browser's when saved.
  const timeZone = initialTask?.timezone || browserTimeZone();
  const movesTimeZone =
    Boolean(initialTask) &&
    timeZoneLabel(initialTask?.timezone) !== timeZoneLabel(timeZone);
  const hasChanges =
    !initialTask ||
    movesTimeZone ||
    name.trim() !== initialTask.name.trim() ||
    prompt.trim() !== initialTask.prompt.trim() ||
    cron !== initialTask.schedule.trim();
  // A new task runs in the project picked here, the current one at first;
  // an edit keeps the task's own.
  const { projects, current, refreshing } = useProjects();
  const runnable = (
    projects.status === "ready" ? projects.projects : []
  ).filter((project) => !project.missing);
  // The project picked, else the current one (it may arrive after the form
  // opens), else the first that can run.
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const projectKey =
    [pickedProject, current?.key].find(
      (key) => key && runnable.some((p) => p.key === key)
    ) ??
    runnable[0]?.key ??
    null;
  // None while the projects are read again: Create waits for them.
  const target = projectKey && !refreshing ? schedulerTarget(projectKey) : null;
  const recoverAssistant = useAssistantRecovery();
  const gateOpen = useSchedulerGate();
  useEffect(() => {
    onBusy(saving);
    return () => onBusy(false);
  }, [saving, onBusy]);
  const canSave = Boolean(
    (initialTask || target) &&
      name.trim() &&
      prompt.trim() &&
      !cronError &&
      hasChanges
  );

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("Task name is required.");
      return;
    }
    if (!prompt.trim()) {
      toast.error("Task description is required.");
      return;
    }
    if (cronError) {
      toast.error(cronError);
      return;
    }
    if (!hasChanges) return;
    const createOn = initialTask ? null : target;
    if (!initialTask && (!createOn || !gateOpen())) return;

    setSaving(true);
    try {
      if (initialTask) {
        const task = await updateScheduledTask({
          cronId: initialTask.cron_id,
          name: name.trim(),
          prompt: prompt.trim(),
          schedule: cron,
          timezone: initialTask.timezone,
          input: initialTask.input,
        });
        toast.success(`"${name.trim()}" updated.`);
        onSaved(task);
      } else if (createOn) {
        await createScheduledTask({
          name: name.trim(),
          prompt: prompt.trim(),
          schedule: cron,
          target: createOn,
        });
        toast.success(`"${name.trim()}" scheduled.`);
        onSaved();
      }
    } catch (err) {
      if (initialTask && scheduledTaskMissing(err)) {
        toast.error(
          `Couldn't find "${initialTask.name}"; it may have been deleted.`
        );
        onSaved();
        return;
      }
      // An edit changes the task in place, so only a create can find the
      // folder's assistant gone.
      if (!initialTask) recoverAssistant(err);
      toast.error(
        err instanceof Error
          ? err.message
          : isEditing
          ? "Failed to update scheduled task."
          : "Failed to create scheduled task."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 sm:px-5">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          aria-label="Back to scheduled tasks"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <ArrowLeft
            className="size-4"
            aria-hidden="true"
          />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">
            {isEditing ? "Edit scheduled task" : "New scheduled task"}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            EvoScientist will run this task description unattended.
          </p>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 sm:p-5">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="scheduled-task-name">Task name</FieldLabel>
            <Input
              id="scheduled-task-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily Briefing"
              autoComplete="off"
            />
          </div>

          {!isEditing && projectKey && (
            <div className="space-y-1.5">
              <FieldLabel>Project</FieldLabel>
              <Select
                value={projectKey}
                onValueChange={(next) => {
                  if (next) setPickedProject(next);
                }}
              >
                <SelectTrigger
                  aria-label="Project"
                  className={cn(INPUT_LIKE_TRIGGER, "sm:min-w-56")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={LIST_MAX_HEIGHT}>
                  {runnable.map((project) => (
                    <SelectItem
                      key={project.key}
                      value={project.key}
                      title={project.key}
                    >
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <FieldLabel htmlFor="scheduled-task-prompt">
              Task description
            </FieldLabel>
            <Textarea
              id="scheduled-task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what EvoScientist should do each time this task runs..."
              rows={9}
              className="min-h-52 resize-y leading-relaxed"
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel>Schedule</FieldLabel>
            <ScheduleBuilder
              value={spec}
              onChange={changeSpec}
              error={cronError}
              timeZone={timeZone}
            />
            {movesTimeZone && (
              <p className="text-xs text-muted-foreground">
                This task has no time zone and runs on UTC time. Saving it
                switches it to {timeZoneLabel(timeZone)} time.
              </p>
            )}
          </div>
        </div>
      </ScrollArea>

      <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border bg-background px-3 py-2.5 sm:px-5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={saving || !canSave}
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : isEditing ? (
            <Pencil className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {isEditing ? "Save changes" : "Create task"}
        </Button>
      </div>
    </form>
  );
}

interface TaskDetailProps {
  task: ScheduledTask;
  onBack: () => void;
  onEdit: () => void;
  /** The task changed in place (paused or resumed). */
  onChanged: (task: ScheduledTask) => void;
  onDeleted: () => void;
  onMissing: () => void;
  /** Whether a pause or resume is in flight: the panel locks what would
   *  leave it. */
  onBusy: (busy: boolean) => void;
  onOpenThread?: (id: string) => void | Promise<void>;
  /** The task's project; it runs there. */
  project: Project | null;
}

function TaskDetail({
  project,
  task,
  onBack,
  onEdit,
  onChanged,
  onDeleted,
  onMissing,
  onBusy,
  onOpenThread,
}: TaskDetailProps) {
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);
  useEffect(() => {
    onBusy(toggling);
    return () => onBusy(false);
  }, [toggling, onBusy]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nextRun = upcomingRun(task);
  const nextRunTitle = formatLongDate(nextRun);
  // A manual run goes where the schedule's runs go: the task's project.
  const runsIn = project && !project.missing ? project.key : null;
  const target = useMemo(
    () =>
      runsIn ? { assistantId: task.assistantId, workspaceDir: runsIn } : null,
    [runsIn, task.assistantId]
  );
  const elsewhere = !project
    ? "This task's project isn't on this backend."
    : project.missing
    ? `${project.name}'s folder is missing: the task won't run until the folder is back.`
    : null;
  const recoverAssistant = useAssistantRecovery();
  const gateOpen = useSchedulerGate();
  const handleRunNow = useCallback(async () => {
    if (!target || elsewhere || !gateOpen()) return;
    setRunning(true);
    try {
      await runScheduledTaskNow(task, target);
      toast.success(`"${task.name}" started.`);
    } catch (err) {
      recoverAssistant(err);
      toast.error(
        err instanceof Error ? err.message : "Failed to start the task."
      );
    } finally {
      setRunning(false);
    }
  }, [task, target, elsewhere, recoverAssistant, gateOpen]);

  const handleToggle = useCallback(async () => {
    setToggling(true);
    try {
      const changed = await setScheduledTaskEnabled(task, !task.enabled);
      toast.success(
        changed.enabled ? `"${task.name}" resumed.` : `"${task.name}" paused.`
      );
      onChanged(changed);
    } catch (err) {
      if (scheduledTaskMissing(err)) {
        toast.error(`Couldn't find "${task.name}"; it may have been deleted.`);
        onMissing();
        return;
      }
      toast.error(
        err instanceof Error
          ? err.message
          : task.enabled
          ? "Failed to pause the task."
          : "Failed to resume the task."
      );
    } finally {
      setToggling(false);
    }
  }, [task, onChanged, onMissing]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteScheduledTask(task.cron_id);
      toast.success(`"${task.name}" deleted.`);
      setDeleteOpen(false);
      onDeleted();
    } catch (err) {
      // Deleted elsewhere already: what the user asked for.
      if (scheduledTaskMissing(err)) {
        toast.success(`"${task.name}" was already deleted.`);
        setDeleteOpen(false);
        onDeleted();
        return;
      }
      toast.error(
        err instanceof Error ? err.message : "Failed to delete the task."
      );
    } finally {
      setDeleting(false);
    }
  }, [task, onDeleted]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 sm:px-5">
          <button
            type="button"
            onClick={onBack}
            disabled={toggling}
            aria-label="Back to scheduled tasks"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <ArrowLeft
              className="size-4"
              aria-hidden="true"
            />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{task.name}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {scheduleLabel(task.schedule, task.timezone)}
              {project && (
                <span title={project.key}>{` · ${project.name}`}</span>
              )}
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleRunNow}
            disabled={
              running ||
              toggling ||
              !target ||
              Boolean(elsewhere) ||
              !task.prompt.trim()
            }
            title={elsewhere ?? undefined}
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Run now
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl space-y-4 p-3 sm:p-5">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-muted-foreground">
                  Next run
                </p>
                <p
                  className="mt-1 truncate text-sm font-medium tabular-nums"
                  title={nextRunTitle}
                >
                  {!task.enabled
                    ? "Paused"
                    : nextRun
                    ? `${nextRunLabel(nextRun)} · ${formatAbsoluteDate(
                        nextRun
                      )}`
                    : "Not scheduled"}
                </p>
              </div>
              <div className="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-muted-foreground">
                  Cron
                </p>
                <p className="mt-1 truncate font-mono text-sm">
                  {task.schedule}
                </p>
              </div>
              <div className="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2">
                <p className="text-[11px] font-medium uppercase text-muted-foreground">
                  Created
                </p>
                <p className="mt-1 truncate text-sm">
                  {formatCreatedDate(task.created_at)}
                </p>
              </div>
            </div>

            <section className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Task description
              </p>
              <div className="max-h-[min(38rem,55vh)] overflow-auto rounded-md border border-border bg-[var(--color-surface)] px-3 py-2.5">
                {task.prompt ? (
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {task.prompt}
                  </p>
                ) : (
                  <p className="text-sm italic text-muted-foreground">
                    No task description stored.
                  </p>
                )}
              </div>
            </section>

            <ScheduledTaskActivity
              task={task}
              onOpenThread={onOpenThread}
            />
          </div>
        </ScrollArea>

        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-border bg-background px-3 py-2.5 sm:px-5">
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            {elsewhere ?? "Manual runs create a scheduler thread immediately."}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleToggle()}
              disabled={toggling}
              aria-label={`${
                task.enabled ? "Pause" : "Resume"
              } scheduled task "${task.name}"`}
            >
              {toggling ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : task.enabled ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {task.enabled ? "Pause" : "Resume"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onEdit}
              disabled={toggling}
              aria-label={`Edit scheduled task "${task.name}"`}
            >
              <Pencil className="size-3.5" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              disabled={toggling}
              aria-label={`Delete scheduled task "${task.name}"`}
              className="text-destructive hover:border-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete scheduled task?</DialogTitle>
            <DialogDescription>
              &ldquo;{task.name}&rdquo; will stop running. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              aria-label={`Confirm delete scheduled task "${task.name}"`}
            >
              {deleting && <Loader2 className="size-3.5 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskRow({
  task,
  active,
  onSelect,
  disabled,
}: {
  task: ScheduledTask;
  active: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const nextRun = upcomingRun(task);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-current={active}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
        active ? "bg-accent" : "hover:bg-accent/60"
      )}
    >
      <span
        className={cn(
          "mt-1 flex size-2 shrink-0 rounded-full",
          task.enabled
            ? "bg-[var(--brand)]"
            : "bg-[var(--color-text-tertiary,var(--muted-foreground))] opacity-40"
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{task.name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {scheduleLabel(task.schedule, task.timezone)}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock
            className="size-3 shrink-0"
            aria-hidden="true"
          />
          <span
            className="truncate tabular-nums"
            title={formatLongDate(nextRun)}
          >
            {!task.enabled
              ? "Paused"
              : nextRun
              ? nextRunLabel(nextRun)
              : "No next run"}
          </span>
        </span>
      </span>
      <ChevronRight
        className="mt-1 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

type RightPane =
  | { kind: "empty" }
  | { kind: "create"; template?: Template; createId: number }
  | { kind: "edit"; task: ScheduledTask; editId: number }
  | { kind: "detail"; task: ScheduledTask };

export function ScheduledTasksPanel({
  onOpenThread,
}: {
  onOpenThread?: (id: string) => void | Promise<void>;
}) {
  const { tasks: allTasks, loading, error, refresh } = useScheduledTasks();
  const [right, setRight] = useState<RightPane>({ kind: "empty" });
  // A save, pause or resume in flight. Until it answers, everything that
  // would change the pane is off: Cancel and the back arrow in the form;
  // Back, Edit, Delete and Run now in the detail; and, here, the list, New
  // task, the templates, Refresh and Retry, which also wait for the list
  // read every write ends with, so the list's old copy can't be opened.
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const createIdRef = useRef(0);
  const editIdRef = useRef(0);

  // Each task's project is the one whose assistant it runs on.
  const { projects } = useProjects();
  const projectList = useMemo(
    () => (projects.status === "ready" ? projects.projects : []),
    [projects]
  );
  const byAssistant = useMemo(
    () => projectsByAssistant(projectList),
    [projectList]
  );
  const projectsPending = projects.status === "pending";
  const projectOf = useCallback(
    (task: ScheduledTask) => byAssistant.get(task.assistantId) ?? null,
    [byAssistant]
  );
  const tasks = useMemo(
    () => registeredTasks(allTasks, projectList),
    [allTasks, projectList]
  );

  const locked = busy || loading;
  // Only the first read shows the spinner, and the projects' too; a re-read
  // keeps what is on screen, an empty list too.
  const [loadedOnce, setLoadedOnce] = useState(false);
  if (!loading && !loadedOnce) setLoadedOnce(true);
  const firstLoad = (loading && !loadedOnce) || projectsPending;
  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks]);
  const filteredTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sortedTasks;
    return sortedTasks.filter((task) =>
      taskSearchText(task).includes(normalized)
    );
  }, [query, sortedTasks]);
  // The shown tasks under their projects, the projects by name.
  const groups = useMemo(
    () =>
      projectList
        .map((project) => ({
          project,
          tasks: filteredTasks.filter((task) => projectOf(task) === project),
        }))
        .filter((group) => group.tasks.length > 0),
    [projectList, filteredTasks, projectOf]
  );
  const nextTask = sortedTasks.find((task) => upcomingRun(task));
  const nextTaskRun = nextTask ? upcomingRun(nextTask) : null;
  const selectedTaskId = right.kind === "detail" ? right.task.cron_id : null;

  // Keep the detail pane in sync with the task list. A write shows the task
  // the server returned and reads the list again; `refresh()` reports
  // loading in that same render, so this effect never applies the list
  // read before the write over it (and the list is locked until the new
  // read is in). A read that failed leaves the pane as it is.
  useEffect(() => {
    if (!selectedTaskId) return;
    // The list holds only tasks of known projects: wait for them too.
    if (loading || error || projectsPending) return;
    const updated = tasks.find((task) => task.cron_id === selectedTaskId);
    setRight(updated ? { kind: "detail", task: updated } : { kind: "empty" });
  }, [error, loading, projectsPending, selectedTaskId, tasks]);

  const openCreate = useCallback((template?: Template) => {
    createIdRef.current += 1;
    setRight({ kind: "create", template, createId: createIdRef.current });
  }, []);

  const openEdit = useCallback((task: ScheduledTask) => {
    editIdRef.current += 1;
    setRight({ kind: "edit", task, editId: editIdRef.current });
  }, []);

  // The pane shows what the server returned at once; the list is read
  // again, so a read that started before the write can't bring back the
  // old copy.
  const handleSaved = useCallback(
    (task?: ScheduledTask) => {
      refresh();
      setRight(task ? { kind: "detail", task } : { kind: "empty" });
    },
    [refresh]
  );

  const handleChanged = useCallback(
    (task: ScheduledTask) => {
      refresh();
      setRight({ kind: "detail", task });
    },
    [refresh]
  );

  const handleDeleted = useCallback(() => {
    refresh();
    setRight({ kind: "empty" });
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-[var(--brand)]">
            <CalendarClock
              className="size-4"
              aria-hidden="true"
            />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold">Scheduled</h1>
              {!firstLoad && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {tasks.length}
                </span>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {nextTaskRun
                ? `Next: ${nextRunLabel(nextTaskRun)}`
                : "Recurring EvoScientist tasks"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={refresh}
            disabled={loading || busy}
            aria-label="Refresh scheduled tasks"
            title="Refresh scheduled tasks"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <RefreshCw
              className={cn("size-4", loading && "animate-spin")}
              aria-hidden="true"
            />
          </button>
          <Button
            size="sm"
            onClick={() => openCreate()}
            disabled={locked}
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">New task</span>
            <span className="sm:hidden">New</span>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "w-full min-w-0 flex-col border-r border-border md:flex md:w-72 md:flex-shrink-0",
            right.kind === "empty" ? "flex" : "hidden"
          )}
        >
          <div className="flex-shrink-0 space-y-2 border-b border-border p-2.5">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                name="scheduled-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search scheduled tasks..."
                aria-label="Search scheduled tasks"
                autoComplete="off"
                spellCheck={false}
                className="h-9 pl-8 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear scheduled task search"
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

          <ScrollArea className="h-0 flex-1">
            {firstLoad ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
                Loading tasks...
              </div>
            ) : error ? (
              <div
                role="alert"
                className="space-y-3 p-3"
              >
                <p className="text-sm text-destructive">{error}</p>
                <Button
                  disabled={locked}
                  variant="outline"
                  size="sm"
                  onClick={refresh}
                >
                  <RefreshCw className="size-3.5" />
                  Retry
                </Button>
              </div>
            ) : tasks.length === 0 ? (
              <div className="space-y-4 p-3">
                <div className="rounded-md border border-dashed border-border bg-[var(--color-surface)] px-3 py-5 text-center">
                  <Calendar
                    className="mx-auto size-7 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                  <p className="mt-2 text-sm font-medium">No scheduled tasks</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Start from a template or create one from scratch.
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="px-1 text-[11px] font-semibold uppercase text-muted-foreground">
                    Templates
                  </p>
                  {TEMPLATES.map((template) => (
                    <TemplateButton
                      key={template.label}
                      template={template}
                      onSelect={openCreate}
                      disabled={locked}
                    />
                  ))}
                </div>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="space-y-3 p-4 text-center">
                <p className="text-sm font-medium">No matching tasks</p>
                <p className="text-xs text-muted-foreground">
                  Try a task name, schedule, or description keyword.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </Button>
              </div>
            ) : (
              <div className="p-1.5">
                <div className="mb-2 flex items-center justify-between px-2 py-1">
                  <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                    Tasks
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {filteredTasks.length}
                  </p>
                </div>
                {groups.map(({ project, tasks: projectTasks }) => (
                  <section
                    key={project.key}
                    aria-label={`Tasks in ${project.name}`}
                    className="mb-2"
                  >
                    <h3
                      className="m-0 flex items-center gap-1.5 px-2 py-1 text-xs font-semibold"
                      title={project.key}
                    >
                      <span className="truncate">{project.name}</span>
                      {project.missing && (
                        <span className="rounded bg-destructive/10 px-1 py-px text-[11px] font-medium text-destructive">
                          folder missing
                        </span>
                      )}
                    </h3>
                    <div className="flex flex-col gap-0.5">
                      {projectTasks.map((task) => {
                        const active =
                          right.kind === "detail" &&
                          right.task.cron_id === task.cron_id;
                        return (
                          <TaskRow
                            key={task.cron_id}
                            task={task}
                            active={active}
                            onSelect={() => setRight({ kind: "detail", task })}
                            disabled={locked}
                          />
                        );
                      })}
                    </div>
                  </section>
                ))}
                <div className="mt-3 space-y-2 border-t border-border px-1 py-3">
                  <p className="px-1 text-[11px] font-semibold uppercase text-muted-foreground">
                    Templates
                  </p>
                  <div className="grid gap-1.5">
                    {TEMPLATES.map((template) => (
                      <TemplateButton
                        key={template.label}
                        template={template}
                        onSelect={openCreate}
                        disabled={locked}
                        compact
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </ScrollArea>
        </aside>

        <section
          className={cn(
            "min-w-0 flex-1 flex-col",
            right.kind === "empty" ? "hidden md:flex" : "flex"
          )}
        >
          {right.kind === "empty" && (
            <div className="flex flex-1 items-center justify-center p-5">
              <div className="w-full max-w-lg space-y-4">
                <div className="space-y-1 text-center">
                  <CalendarClock
                    className="mx-auto size-9 text-muted-foreground/40"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium">Pick a scheduled task</p>
                  <p className="text-xs text-muted-foreground">
                    Pick a template below, or ask EvoScientist in chat to create
                    a recurring task.
                  </p>
                </div>
                {tasks.length > 0 && (
                  <div className="mx-auto grid w-full max-w-xl gap-2 sm:grid-cols-2">
                    {TEMPLATES.map((template) => (
                      <TemplateButton
                        key={template.label}
                        template={template}
                        onSelect={openCreate}
                        disabled={locked}
                        compact
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {right.kind === "create" && (
            <TaskForm
              key={right.createId}
              initialTemplate={right.template}
              onSaved={handleSaved}
              onCancel={() => setRight({ kind: "empty" })}
              onBusy={setBusy}
            />
          )}

          {right.kind === "edit" && (
            <TaskForm
              key={right.editId}
              initialTask={right.task}
              onSaved={handleSaved}
              onCancel={() => setRight({ kind: "detail", task: right.task })}
              onBusy={setBusy}
            />
          )}

          {right.kind === "detail" && (
            <TaskDetail
              key={right.task.cron_id}
              project={projectOf(right.task)}
              task={right.task}
              onBack={() => setRight({ kind: "empty" })}
              onEdit={() => openEdit(right.task)}
              onChanged={handleChanged}
              onDeleted={handleDeleted}
              onMissing={handleDeleted}
              onBusy={setBusy}
              onOpenThread={onOpenThread}
            />
          )}
        </section>
      </div>
    </div>
  );
}
