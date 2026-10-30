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
import { addProject, projectsReadOnlyReason } from "@/lib/projectActions";
import {
  projectWork,
  removeProjectAndWork,
  stopProjectRuns,
  type StopRunsResult,
  type ProjectWork,
} from "@/lib/projectRemoval";
import type { Project } from "@/lib/projects";
import { ProjectDialogsContext } from "@/providers/projectDialogsContext";

/**
 * The dialogs that add and remove projects, for every surface (the sidebar,
 * the composer, a read-only conversation). Neither moves the page: what is
 * open stays open, and a new chat is the user's to start.
 */
export function ProjectDialogsProvider({ children }: { children: ReactNode }) {
  const [adding, setAdding] = useState<{ folder: string } | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const openAddProject = useCallback(
    (folder?: string) => setAdding({ folder: folder ?? "" }),
    []
  );
  const openRemoveProject = useCallback(
    (project: Project) => setRemoving(project),
    []
  );
  const value = useMemo(
    () => ({ openAddProject, openRemoveProject }),
    [openAddProject, openRemoveProject]
  );
  return (
    <ProjectDialogsContext.Provider value={value}>
      {children}
      {adding && (
        <AddProjectDialog
          initialFolder={adding.folder}
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

function AddProjectDialog({
  initialFolder,
  onClose,
}: {
  initialFolder: string;
  onClose: () => void;
}) {
  const { refresh } = useProjects();
  const readOnly = useProjectsReadOnlyReason();
  const [folder, setFolder] = useState(initialFolder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const path = folder.trim();
    if (!path || busy || readOnly) return;
    setBusy(true);
    setError(null);
    const result = await addProject(path);
    if (!result.ok) {
      setBusy(false);
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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            A folder on the machine that runs EvoScientist. Its conversations
            and scheduled tasks come back with it.
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
              disabled={busy}
              aria-invalid={error !== null}
              aria-describedby={error ? "add-project-error" : undefined}
            />
            <p
              role="status"
              className="text-xs text-muted-foreground"
            >
              {busy
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
            disabled={busy}
          >
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              onClick={() => void submit()}
              disabled={busy || !folder.trim()}
            >
              {busy && (
                <Loader2
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              Add
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
    toast.success(`${project.name} removed from the sidebar.`);
    onClose();
  };

  const stopAgain = async () => {
    if (!removed || stopping) return;
    setStopping(true);
    try {
      const again = await stopProjectRuns(
        client,
        project.key,
        removed.unstopped
      );
      if (again.checked && again.unstopped.length === 0) {
        toast.success(`${project.name} removed from the sidebar.`);
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
            <DialogTitle>{project.name} removed from the sidebar</DialogTitle>
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
          <DialogTitle>Remove {project.name} from the sidebar?</DialogTitle>
          <DialogDescription>
            Its folder, files and conversations stay. Its conversations come
            back when the folder is added again, or when EvoScientist runs in
            it.
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
              {action ? `${action} and remove` : "Remove from sidebar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
