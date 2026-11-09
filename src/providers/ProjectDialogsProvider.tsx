"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSettingsAccess } from "@/app/hooks/useSettings";
import { useClient } from "@/providers/ClientProvider";
import { useProjects } from "@/providers/ProjectsProvider";
import {
  addProject,
  moveProject,
  movedText,
  projectsReadOnlyReason,
  typedFolder,
} from "@/lib/projectActions";
import {
  projectWork,
  removeProjectAndWork,
  stopProjectRuns,
  type StopRunsResult,
  type ProjectWork,
} from "@/lib/projectRemoval";
import type { Project } from "@/lib/projects";
import { folderName } from "@/lib/workspaceAssistant";
import { ProjectDialogsContext } from "@/providers/projectDialogsContext";

/**
 * The dialogs that add, move and remove projects, for every surface (the
 * sidebar, the composer, a read-only conversation). What is open stays open,
 * and a new chat is the user's to start; a moved project stays the current
 * one, in its new folder.
 */
export function ProjectDialogsProvider({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState<{
    folder: string;
    moving: Project | null;
  } | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const canMove = useCanMoveProjects();
  const openAddProject = useCallback(
    (folder?: string) => setAdding({ folder: folder ?? "", moving: null }),
    []
  );
  const openMoveProject = useCallback(
    (project: Project) => setAdding({ folder: "", moving: project }),
    []
  );
  const openRemoveProject = useCallback(
    (project: Project) => setRemoving(project),
    []
  );
  const value = useMemo(
    () => ({
      openAddProject,
      openRemoveProject,
      openMoveProject: canMove ? openMoveProject : undefined,
    }),
    [openAddProject, openRemoveProject, openMoveProject, canMove]
  );
  return (
    <ProjectDialogsContext.Provider value={value}>
      {children}
      {adding && (
        <ProjectFolderDialog
          initialFolder={adding.folder}
          moving={adding.moving}
          onClose={() => setAdding(null)}
        />
      )}
      {removing && (
        <RemoveProjectDialog
          project={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </ProjectDialogsContext.Provider>
  );
}

/** Why this page can't change projects, or null when it can. */
function useProjectsReadOnlyReason(): string | null {
  return projectsReadOnlyReason(useSettingsAccess().access);
}

/** Whether this page offers to move a project: it can change projects and
 *  the backend can move one. */
function useCanMoveProjects(): boolean {
  const { canMove } = useProjects();
  const readOnly = useProjectsReadOnlyReason();
  return canMove && readOnly === null;
}

/** The projects whose folder is missing, and `chosen` while it is chosen
 *  (a move cut short may finish and drop it from the list), those named like
 *  `folder` first. Names compare ignoring case, as folders may. */
function moveCandidates(
  projects: readonly Project[],
  folder: string,
  chosen: Project | null
): Array<{ project: Project; sameName: boolean }> {
  const name = folderName(typedFolder(folder)).toLowerCase();
  const missing = projects.filter((project) => project.missing);
  if (chosen && !missing.some((project) => project.key === chosen.key)) {
    missing.push(chosen);
  }
  return missing
    .map((project) => ({
      project,
      sameName: name !== "" && folderName(project.key).toLowerCase() === name,
    }))
    .sort((a, b) => Number(b.sameName) - Number(a.sameName));
}

/** The registered project, other than `moving`, at the typed `folder`: a
 *  move there merges into it. Paths compare ignoring case, the kind of
 *  separator and a trailing one, as folders may. */
function mergeTarget(
  projects: readonly Project[],
  folder: string,
  moving: Project
): Project | null {
  const path = (key: string) =>
    key
      .replace(/[\\/]+/g, "/")
      .replace(/\/$/, "")
      .toLowerCase();
  const typed = path(typedFolder(folder));
  if (!typed) return null;
  return (
    projects.find(
      (project) => project.key !== moving.key && path(project.key) === typed
    ) ?? null
  );
}

/**
 * Ask for a folder: to add as a project, or, for `moving` (a project whose
 * folder is missing), the folder it was moved to. Adding offers the missing
 * projects too, when the backend can move one: the folder may be one of them,
 * moved. Nothing is moved unless one is chosen.
 */
function ProjectFolderDialog({
  initialFolder,
  moving,
  onClose,
}: {
  initialFolder: string;
  moving: Project | null;
  onClose: () => void;
}) {
  const { projects, refresh, followMove } = useProjects();
  const readOnly = useProjectsReadOnlyReason();
  const canMove = useCanMoveProjects();
  const [folder, setFolder] = useState(initialFolder);
  // The missing project this folder is; null: a new project.
  const [choice, setChoice] = useState<Project | null>(null);
  const [busy, setBusy] = useState<"add" | "move" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates =
    !moving && canMove && projects.status === "ready"
      ? moveCandidates(projects.projects, folder, choice)
      : [];
  const target = moving ?? (candidates.length > 0 ? choice : null);
  const mergeInto =
    target && projects.status === "ready"
      ? mergeTarget(projects.projects, folder, target)
      : null;

  const add = async (path: string) => {
    const result = await addProject(path);
    if (!result.ok) {
      setBusy(null);
      setError(result.message);
      return;
    }
    // The list is read again in the background: the project is added.
    void refresh();
    for (const warning of result.warnings) {
      toast.warning(warning, { duration: 15_000 });
    }
    toast.success("Project added.");
    onClose();
  };

  const move = async (project: Project, path: string) => {
    const result = await moveProject(project.key, path);
    if (!result.ok) {
      setBusy(null);
      setError(result.message);
      return;
    }
    if (!result.moved) {
      void refresh();
      // The old folder is a project again: its warning says so.
      for (const warning of result.warnings.length > 0
        ? result.warnings
        : [`${project.name} was not moved.`]) {
        toast.warning(warning, { duration: 15_000 });
      }
      onClose();
      return;
    }
    // Its old key names nothing now: a selection or stored choice of it
    // moves to the new folder, before the list that drops it is read.
    followMove(project.key, result.key);
    void refresh();
    toast.success(movedText(project.name, result));
    for (const warning of result.warnings) {
      toast.warning(warning, { duration: 15_000 });
    }
    onClose();
  };

  const submit = async () => {
    const path = folder.trim();
    if (!path || busy || readOnly) return;
    setBusy(target ? "move" : "add");
    setError(null);
    await (target ? move(target, path) : add(path));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {moving ? `Where is ${moving.name} now?` : "Add project"}
          </DialogTitle>
          <DialogDescription>
            {moving
              ? `Its folder ${moving.key} is missing. Give the folder it was moved to: its conversations, scheduled tasks and memory follow it. No files are moved.`
              : "A folder on the machine that runs EvoScientist. Its conversations and scheduled tasks come back with it."}
          </DialogDescription>
        </DialogHeader>
        {readOnly ? (
          <p className="text-sm text-muted-foreground">{readOnly}</p>
        ) : (
          <div className="space-y-2">
            <label
              htmlFor="add-project-folder"
              className="text-xs font-medium text-muted-foreground"
            >
              Folder
            </label>
            <Input
              id="add-project-folder"
              autoFocus
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="/home/you/my-project"
              spellCheck={false}
              autoComplete="off"
              disabled={busy !== null}
              aria-invalid={error !== null}
              aria-describedby={
                [error && "add-project-error", mergeInto && "add-project-merge"]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
            {candidates.length > 0 && (
              <fieldset
                className="space-y-1 pt-1"
                disabled={busy !== null}
              >
                <legend className="text-xs font-medium text-muted-foreground">
                  Is this one of these, moved here? This folder is:
                </legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="add-project-choice"
                    checked={target === null}
                    onChange={() => setChoice(null)}
                  />
                  a new project
                </label>
                {candidates.map(({ project, sameName }) => (
                  <label
                    key={project.key}
                    className="flex items-start gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="add-project-choice"
                      className="mt-1"
                      checked={target?.key === project.key}
                      onChange={() => setChoice(project)}
                    />
                    <span className="min-w-0 break-all">
                      {project.name}{" "}
                      <span className="text-muted-foreground">
                        (moved from {project.key})
                      </span>
                      {sameName && (
                        <span className="ml-1 rounded bg-muted px-1 py-px text-[11px] font-medium">
                          same name
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <p
              id="add-project-merge"
              role="status"
              className="text-xs text-amber-700 empty:hidden dark:text-amber-300"
            >
              {target && mergeInto
                ? `${mergeInto.name} is already a project; ${target.name}'s conversations, scheduled tasks and memory will be merged into it.`
                : ""}
            </p>
            <p
              role="status"
              className="text-xs text-muted-foreground"
            >
              {busy === "move"
                ? "Moving the project's conversations, scheduled tasks and memory…"
                : busy === "add"
                ? "Adding the project and restoring its conversations and scheduled tasks…"
                : ""}
            </p>
            {error && (
              <p
                id="add-project-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={busy !== null}
          >
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              onClick={() => void submit()}
              disabled={busy !== null || !folder.trim()}
            >
              {busy && (
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {target ? "Move" : "Add"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the dialog says once the project is removed with work that may
 *  go on. */
function removedText({ unstopped, checked }: StopRunsResult): string {
  if (checked)
    return "These runs couldn't be cancelled and may still be going:";
  return unstopped.length > 0
    ? "Its runs couldn't be checked, and these couldn't be cancelled: some may still be going."
    : "Its runs couldn't be checked: some may still be going.";
}

function RemoveProjectDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const client = useClient();
  const { refresh } = useProjects();
  // Tasks the backend named as on, which the list didn't have.
  const [named, setNamed] = useState<string[]>([]);
  const readOnly = useProjectsReadOnlyReason();
  const [work, setWork] = useState<ProjectWork | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once removed with work that may go on: how stopping its runs went.
  const [removed, setRemoved] = useState<StopRunsResult | null>(null);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    projectWork(client, project.key).then(setWork, () =>
      setLoadError("Couldn't check what runs in this project.")
    );
  }, [client, project.key]);
  useEffect(() => {
    if (!readOnly) load();
  }, [load, readOnly]);

  const confirm = async () => {
    if (!work || busy) return;
    setBusy(true);
    setError(null);
    const extra = named
      .filter((id) => !work.tasks.some((task) => task.id === id))
      .map((id) => ({ id, name: `Task ${id.slice(0, 8)}` }));
    const result = await removeProjectAndWork(
      client,
      project.key,
      { ...work, tasks: [...work.tasks, ...extra] },
      async () => {
        const state = await refresh();
        return (
          state.status !== "ready" ||
          state.projects.some((p) => p.key === project.key)
        );
      }
    );
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      // Tasks that are on, which this list didn't show: pause them too
      // on the next try.
      if (result.cronIds.length > 0) {
        setNamed(result.cronIds);
        load();
      }
      return;
    }
    void refresh();
    if (!result.checked || result.unstopped.length > 0) {
      // Removed, but work may go on out of sight: say so, and offer to
      // stop it again.
      setBusy(false);
      setRemoved({ unstopped: result.unstopped, checked: result.checked });
      return;
    }
    toast.success(`${project.name} removed.`);
    onClose();
  };

  const stopAgain = async () => {
    if (!removed || !work || stopping) return;
    setStopping(true);
    try {
      const again = await stopProjectRuns(
        client,
        project.key,
        work,
        removed.unstopped
      );
      if (again.checked && again.unstopped.length === 0) {
        toast.success(`${project.name} removed.`);
        onClose();
        return;
      }
      setRemoved(again);
      toast.warning(`Some of ${project.name}'s runs may still be going.`);
    } finally {
      setStopping(false);
    }
  };

  const runs = work?.running.length ?? 0;
  const unlisted = named.filter(
    (id) => !work?.tasks.some((task) => task.id === id)
  ).length;
  const tasks = (work?.tasks.length ?? 0) + unlisted;
  const parts = [
    runs > 0 && `stop ${runs} run${runs === 1 ? "" : "s"}`,
    tasks > 0 && `pause ${tasks} task${tasks === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(", ");
  const action = parts && parts[0].toUpperCase() + parts.slice(1);

  if (removed) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{project.name} removed</DialogTitle>
            <DialogDescription>{removedText(removed)}</DialogDescription>
          </DialogHeader>
          {removed.unstopped.length > 0 && (
            <ul className="ml-4 list-disc text-sm text-muted-foreground">
              {removed.unstopped.map((t) => (
                <li key={t.id}>{t.title}</li>
              ))}
            </ul>
          )}
          <p
            role="status"
            className="sr-only"
          >
            {stopping ? "Stopping the runs…" : ""}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={onClose}
            >
              Close
            </Button>
            <Button
              onClick={() => void stopAgain()}
              disabled={stopping}
            >
              {stopping && (
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              Stop them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove the project {project.name}?</DialogTitle>
          <DialogDescription>
            The backend stops serving it, for every app connected to it, and its
            running conversations stop. Its folder, files and conversations
            stay. Its conversations come back when the folder is added again, or
            when EvoScientist runs in it.
          </DialogDescription>
        </DialogHeader>
        {readOnly ? (
          <p className="text-sm text-muted-foreground">{readOnly}</p>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-2">
            <p
              role="alert"
              className="text-sm text-destructive"
            >
              {loadError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
            >
              Retry
            </Button>
          </div>
        ) : !work ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
            Checking what runs in this project…
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            {runs > 0 && (
              <div>
                <p className="font-medium">Running now (stopped):</p>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {work.running.map((t) => (
                    <li key={t.id}>{t.title}</li>
                  ))}
                </ul>
              </div>
            )}
            {tasks > 0 && (
              <div>
                <p className="font-medium">Scheduled tasks (paused):</p>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {work.tasks.map((t) => (
                    <li key={t.id}>{t.name}</li>
                  ))}
                  {unlisted > 0 && (
                    <li>{unlisted} more the backend named as on</li>
                  )}
                </ul>
              </div>
            )}
            {error && (
              <p
                role="alert"
                className="text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        )}
        <p
          role="status"
          className="sr-only"
        >
          {busy
            ? "Removing the project…"
            : !work && !loadError && !readOnly
            ? "Checking what runs in this project…"
            : ""}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              onClick={() => void confirm()}
              disabled={busy || !work}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy && (
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {action ? `${action} and remove` : "Remove project"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
