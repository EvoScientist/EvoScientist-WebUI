"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryState } from "nuqs";
import { Loader2, RotateCw } from "lucide-react";
import {
  SkillDetailDialog,
  type SkillDetailTarget,
} from "@/app/components/SkillDetailDialog";
import { SkillTile } from "@/app/components/SkillTile";
import { DraftsBanner } from "@/app/components/autoskills/DraftsBanner";
import { DraftsPage } from "@/app/components/autoskills/DraftsPage";
import { refreshAutoSkills, useAutoSkills } from "@/app/hooks/useAutoSkills";
import { notifyTeamsChanged } from "@/app/hooks/useTeams";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fromMemorySkills, labelFor, projectLabels } from "@/lib/autoskills";
import { projectHandle, type Project } from "@/lib/projects";
import { useProjects } from "@/providers/ProjectsProvider";

interface SkillCard {
  name: string;
  title: string;
  description: string;
  dir: string;
  /** Also carries an EXPERT.md, so it can be dispatched as an expert too. */
  isExpert?: boolean;
  /** False only when `metadata.type` explicitly omits `skill`. */
  isSkill?: boolean;
}

interface CatalogSkill {
  name: string;
  title: string;
  description: string;
  fileCount: number;
  installed: boolean;
  latestVersion?: string;
  installedVersion?: string;
  updateAvailable: boolean;
  /** Also carries an EXPERT.md, so it can be dispatched as an expert too. */
  isExpert?: boolean;
  /** False only when `metadata.type` explicitly omits `skill` — such an entry
   *  is an actor with no standalone use here, and lives under Experts. */
  isSkill?: boolean;
}

/** The tag of a skill an approved draft installed. */
const MEMORY_TAGS = {
  create: "from memory",
  update: "updated from memory",
} as const;

function memoryTag(
  installs: ReadonlyMap<string, "create" | "update"> | undefined,
  name: string
): string | undefined {
  const operation = installs?.get(name);
  return operation ? MEMORY_TAGS[operation] : undefined;
}

/** A project skill's busy key: apart from a global skill and from another
 *  project's skill of the same name. */
const projectBusyKey = (key: string, name: string) =>
  JSON.stringify(["project", key, name]);

const NO_PROJECTS: readonly Project[] = [];

/** An entry whose `metadata.type` omits `skill` is an actor, not a tool: it
 *  belongs under Experts only. Absence of the field means yes, so nothing
 *  disappears just because an author never wrote it. */
const belongsHere = (s: { isSkill?: boolean }) => s.isSkill !== false;

async function readCatalog(refresh: boolean): Promise<CatalogSkill[]> {
  const r = await fetch(`/api/skills/catalog${refresh ? "?refresh=1" : ""}`);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to load catalog");
  return (d.skills ?? []) as CatalogSkill[];
}

/** The global tiers' skills, and the project `key`'s own (null when the
 *  route doesn't serve that project's folder). */
async function readInstalled(key: string | null): Promise<{
  skills: SkillCard[];
  projectSkills: SkillCard[] | null;
}> {
  const r = await fetch(
    key ? `/api/skills?project=${projectHandle(key)}` : "/api/skills"
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Failed to load skills");
  return {
    skills: (d.skills ?? []) as SkillCard[],
    projectSkills: Array.isArray(d.projectSkills)
      ? (d.projectSkills as SkillCard[])
      : null,
  };
}

/** Research Skills, or its "Drafted from memory" sub-page. Coming back
 *  mounts the skills again, so their lists are read anew. */
export function SkillsMarketplace() {
  const [skillsPage] = useQueryState("skillsPage");
  return skillsPage === "drafts" ? <DraftsPage /> : <SkillsHome />;
}

function SkillsHome() {
  const [, setView] = useQueryState("view");
  const { projects, current, files } = useProjects();
  // The current project's own skills/ show where this page reads its files.
  const projectKey = current && files === "here" ? current.key : null;
  // A read takes the project known when it starts.
  const projectKeyRef = useRef(projectKey);
  useEffect(() => {
    projectKeyRef.current = projectKey;
  }, [projectKey]);
  const auto = useAutoSkills();
  const drafts = auto.status === "ready" ? auto.list : null;
  const currentKey = current?.key ?? null;
  // The installed skills approved drafts put there, while the drafts are
  // known: tagged in this project's skills and the global ones.
  const fromMemory = useMemo(
    () => (drafts ? fromMemorySkills(drafts, currentKey) : null),
    [drafts, currentKey]
  );
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [other, setOther] = useState<SkillCard[]>([]);
  // The skills of the project `key` (read with its handle).
  const [projectSkills, setProjectSkills] = useState<{
    key: string;
    skills: SkillCard[];
  } | null>(null);
  // Why the newest read of a project's skills failed: that section's own,
  // gone at its next read.
  const [projectError, setProjectError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-skill in-flight action, keyed by skill name (`projectBusyKey` for a
  // project's own skill).
  const [busy, setBusy] = useState<
    Record<string, "install" | "uninstall" | "update">
  >({});
  // Skill whose detail dialog is open (null = closed).
  const [detail, setDetail] = useState<SkillDetailTarget | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<{
    name: string;
    title: string;
    isCatalog: boolean;
    /** The project whose skills/ holds it; absent for the global tier. */
    project?: string;
  } | null>(null);
  // The dialog keeps the last skill's words while it fades out.
  const [shownTarget, setShownTarget] = useState(uninstallTarget);
  if (uninstallTarget !== null && uninstallTarget !== shownTarget) {
    setShownTarget(uninstallTarget);
  }
  const dialogTarget = uninstallTarget ?? shownTarget;
  // Projects as the drafts pages and their toasts name them.
  const labels = useMemo(
    () =>
      projectLabels(
        projects.status === "ready" ? projects.projects : NO_PROJECTS
      ),
    [projects]
  );
  // The newest read wins, one count for the page (catalog, global lists,
  // loading) and one for this project's skills: a read settling late would
  // bring back what is gone.
  const pageSeq = useRef(0);
  const projectSeq = useRef(0);
  // The project the newest read of a project's skills asked for.
  const projectAsked = useRef<string | null>(null);

  // The page: the catalog and the global lists. Never a project's skills,
  // which have their own read: one read for both made the page wait for a
  // project (the check may never answer), and an old project's late answer
  // wrote over the next one's page.
  const load = useCallback(async (refresh = false, quiet = false) => {
    const page = ++pageSeq.current;
    if (!quiet) setLoading(true);
    setError(null);
    setCatalogError(null);
    const [catRes, instRes] = await Promise.allSettled([
      readCatalog(refresh),
      readInstalled(null),
    ]);
    if (page !== pageSeq.current) return;

    const cat = (catRes.status === "fulfilled" ? catRes.value : []).filter(
      belongsHere
    );
    if (catRes.status === "rejected") {
      setCatalogError(
        catRes.reason instanceof Error
          ? catRes.reason.message
          : "Failed to load the official catalog."
      );
    }
    setCatalog(cat);

    // Installed skills that aren't in the official catalog (custom/local ones).
    if (instRes.status === "fulfilled") {
      const catNames = new Set(cat.map((c) => c.name));
      setOther(
        instRes.value.skills.filter(
          (s) => !catNames.has(s.name) && belongsHere(s)
        )
      );
    } else {
      setOther([]);
      setError(
        instRes.reason instanceof Error
          ? instRes.reason.message
          : "Failed to load installed skills."
      );
    }
    setLoading(false);
  }, []);

  // "This project's skills" alone, with its own count and error: read once
  // the project is known here, on a project switch and after a change to
  // them, without loading the page again.
  const loadProject = useCallback(async (key: string) => {
    const mine = ++projectSeq.current;
    projectAsked.current = key;
    setProjectError(null);
    try {
      const { projectSkills: own } = await readInstalled(key);
      if (mine !== projectSeq.current) return;
      setProjectSkills(own ? { key, skills: own.filter(belongsHere) } : null);
    } catch (e) {
      if (mine !== projectSeq.current) return;
      setProjectSkills(null);
      setProjectError({
        key,
        message: e instanceof Error ? e.message : "Failed to load skills",
      });
    }
  }, []);

  /** The page and, when one is known here, the project's skills. */
  const reloadAll = (refresh: boolean, quiet: boolean) => {
    void load(refresh, quiet);
    const key = projectKeyRef.current;
    if (key !== null) void loadProject(key);
  };

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (projectKey === null) {
      projectAsked.current = null;
    } else if (projectAsked.current !== projectKey) {
      void loadProject(projectKey);
    }
  }, [projectKey, loadProject]);

  // Install and update hit the same endpoint (it overwrites + re-records the
  // manifest commit); the mode only changes the busy label and success state.
  const install = async (
    name: string,
    mode: "install" | "update" = "install"
  ) => {
    setBusy((b) => ({ ...b, [name]: mode }));
    setError(null);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Failed to install");
      setCatalog((prev) =>
        prev.map((s) =>
          s.name === name
            ? {
                ...s,
                installed: true,
                updateAvailable: false,
                installedVersion: s.latestVersion ?? s.installedVersion,
              }
            : s
        )
      );
      // A skill installed here may be an expert; the Experts view and the
      // composer pill hold their own copy of that list.
      notifyTeamsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${mode}`);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[name];
        return next;
      });
    }
  };

  const uninstall = async (name: string, isCatalog: boolean) => {
    setBusy((b) => ({ ...b, [name]: "uninstall" }));
    setError(null);
    try {
      const res = await fetch(`/api/skills?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Failed to uninstall");
      }
      if (isCatalog) {
        setCatalog((prev) =>
          prev.map((s) => (s.name === name ? { ...s, installed: false } : s))
        );
      } else {
        setOther((prev) => prev.filter((s) => s.name !== name));
      }
      notifyTeamsChanged();
      // A from-memory skill's draft says at once that it is gone.
      void refreshAutoSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to uninstall");
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[name];
        return next;
      });
    }
  };

  // A project's own skill: removed from its skills/ alone. The drafts read
  // again too (an approved draft's skill is gone), and so do the experts.
  const uninstallFromProject = async (key: string, name: string) => {
    const busyKey = projectBusyKey(key, name);
    setBusy((b) => ({ ...b, [busyKey]: "uninstall" }));
    setError(null);
    try {
      const res = await fetch(
        `/api/skills?project=${projectHandle(key)}&name=${encodeURIComponent(
          name
        )}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || "Failed to uninstall");
      }
      setProjectSkills((prev) =>
        prev && prev.key === key
          ? { key, skills: prev.skills.filter((s) => s.name !== name) }
          : prev
      );
      reloadAll(false, true);
      void refreshAutoSkills();
      notifyTeamsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to uninstall");
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[busyKey];
        return next;
      });
    }
  };

  const confirmUninstall = async () => {
    if (!uninstallTarget) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    if (target.project !== undefined) {
      await uninstallFromProject(target.project, target.name);
    } else {
      await uninstall(target.name, target.isCatalog);
    }
  };

  // The list read for the current project; one read for another project
  // (the current one changed meanwhile) isn't shown under its name, nor is
  // its error.
  const own =
    projectKey && projectSkills?.key === projectKey ? projectSkills : null;
  const ownError =
    projectKey && projectError?.key === projectKey
      ? projectError.message
      : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 py-5 sm:px-5 sm:py-6">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold sm:text-2xl">
              Research Skills
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Install official skills from the{" "}
              <a
                href="https://github.com/EvoScientist/EvoSkills"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                EvoSkills
              </a>{" "}
              catalog, or remove ones you don&apos;t need.
            </p>
          </div>
          <button
            type="button"
            onClick={() => reloadAll(true, false)}
            disabled={loading}
            aria-label="Refresh"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw
              className={loading ? "size-4 animate-spin" : "size-4"}
              aria-hidden="true"
            />
          </button>
        </header>

        <DraftsBanner />

        {error && (
          <p
            role="alert"
            className="mb-4 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {loading ? (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
            Loading skills…
          </div>
        ) : (
          <div className="space-y-6">
            <section>
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-tertiary">
                Official catalog
              </h3>
              {catalogError ? (
                <p className="text-sm text-muted-foreground">{catalogError}</p>
              ) : catalog.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No skills found in the catalog.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {catalog.map((s) => (
                    <SkillTile
                      key={s.name}
                      title={s.title}
                      description={s.description}
                      meta={`${s.fileCount} file${
                        s.fileCount === 1 ? "" : "s"
                      }`}
                      installed={s.installed}
                      installedVersion={s.installedVersion}
                      latestVersion={s.latestVersion}
                      updateAvailable={s.updateAvailable}
                      busy={busy[s.name]}
                      actions={expertBadge(s.isExpert, setView)}
                      onOpen={() =>
                        setDetail({
                          name: s.name,
                          title: s.title,
                          description: s.description,
                          version: s.installed
                            ? s.installedVersion
                            : s.latestVersion,
                          fileCount: s.fileCount,
                          installed: s.installed,
                        })
                      }
                      onInstall={() => install(s.name)}
                      onUpdate={() => install(s.name, "update")}
                      onUninstall={() =>
                        setUninstallTarget({
                          name: s.name,
                          title: s.title,
                          isCatalog: true,
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            {/* A failed read also drops the list, so never both. */}
            {ownError && (
              <section>
                <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-tertiary">
                  This project&apos;s skills
                </h3>
                <p
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {ownError}
                </p>
              </section>
            )}

            {own && own.skills.length > 0 && (
              <section>
                <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-tertiary">
                  This project&apos;s skills
                </h3>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {own.skills.map((s) => (
                    <SkillTile
                      key={s.name}
                      title={s.title}
                      description={s.description}
                      installed
                      tag={memoryTag(fromMemory?.project, s.name)}
                      busy={busy[projectBusyKey(own.key, s.name)]}
                      actions={expertBadge(s.isExpert, setView)}
                      onUninstall={() =>
                        setUninstallTarget({
                          name: s.name,
                          title: s.title,
                          isCatalog: false,
                          project: own.key,
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {other.length > 0 && (
              <section>
                <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-tertiary">
                  Other installed skills
                </h3>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {other.map((s) => (
                    <SkillTile
                      key={s.name}
                      title={s.title}
                      description={s.description}
                      installed
                      tag={memoryTag(fromMemory?.global, s.name)}
                      busy={busy[s.name]}
                      actions={expertBadge(s.isExpert, setView)}
                      onOpen={() =>
                        setDetail({
                          name: s.name,
                          title: s.title,
                          description: s.description,
                          installed: true,
                        })
                      }
                      onUninstall={() =>
                        setUninstallTarget({
                          name: s.name,
                          title: s.title,
                          isCatalog: false,
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <SkillDetailDialog
        skill={detail}
        onClose={() => setDetail(null)}
      />
      <Dialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Uninstall skill?</DialogTitle>
            <DialogDescription>
              {dialogTarget?.project !== undefined ? (
                // A project's own folder: deleted, with nothing to install
                // it again from.
                `This deletes the folder ${labelFor(
                  dialogTarget.project,
                  labels
                )}/skills/${dialogTarget.name}. It can't be undone.`
              ) : (
                <>
                  “{dialogTarget?.title ?? dialogTarget?.name}” will be removed
                  from this Web UI. You can install it again later.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUninstallTarget(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmUninstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {dialogTarget?.project !== undefined ? "Delete" : "Uninstall"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The "also an expert" marker. Clicking it crosses over to the Experts view,
 *  where the same skill appears again with its persona and actor identity. */
function expertBadge(
  isExpert: boolean | undefined,
  setView: (v: string) => void
) {
  if (!isExpert) return undefined;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void setView("experts");
      }}
      className="shrink-0 rounded-full border border-solid border-[var(--brand)] bg-[var(--brand-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand)] transition-colors focus-visible:ring-2 focus-visible:ring-ring enabled:hover:border-[var(--brand-hover)] enabled:hover:text-[var(--brand-hover)]"
      title="Also an expert — can be dispatched to run a task on its own"
    >
      Expert
    </button>
  );
}
