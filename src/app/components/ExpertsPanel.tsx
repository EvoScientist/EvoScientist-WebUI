"use client";

// The Experts view: the same gallery as Research Skills, narrowed to skills
// that ship an EXPERT.md. An expert IS a skill — it keeps appearing in Research
// Skills too, with the same install state — so this reuses SkillTile and the
// detail dialog rather than introducing a parallel component tree. The one
// thing it adds is the Active state — installing is what makes an expert
// dispatchable, so there is no control to add.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw, TriangleAlert, Users } from "lucide-react";

import { useTeams } from "@/app/hooks/useTeams";
import {
  buildExpertSections,
  type CatalogExpert,
  type InstalledExpert,
} from "@/lib/teams";
import {
  SkillDetailDialog,
  type SkillDetailTarget,
} from "@/app/components/SkillDetailDialog";
import { SkillTile } from "@/app/components/SkillTile";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Busy = "install" | "uninstall" | "update";

/** Installed means dispatchable: the orchestrator picks experts itself, and
 *  `active_teams` was only ever a prompt-level preference. So the card carries
 *  a state, not a control. */
const activeBadge = (
  <span
    className="shrink-0 rounded-full border border-[var(--brand)] bg-[var(--brand-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand)]"
    title="Installed — the orchestrator can dispatch it"
  >
    Active
  </span>
);

export function ExpertsPanel() {
  const { teams, refresh: refreshTeams } = useTeams();
  const [catalog, setCatalog] = useState<CatalogExpert[]>([]);
  const [installed, setInstalled] = useState<InstalledExpert[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [detail, setDetail] = useState<SkillDetailTarget | null>(null);
  // Every mutation reloads, so two loads can be in flight at once. Only the
  // newest one may write state — an older snapshot settling late would bring
  // back an expert that has since been uninstalled. Same guard as
  // `useAsyncAgents`.
  const loadSeqRef = useRef(0);
  // Uninstall is an unguarded recursive delete server-side, and a
  // hand-written expert may have no catalog copy to reinstall from — so it
  // asks first, exactly like Research Skills does for the same skill.
  const [uninstallTarget, setUninstallTarget] = useState<{
    name: string;
    title: string;
  } | null>(null);

  const load = useCallback(async (force = false) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const [cat, inst] = await Promise.allSettled([
      fetch(`/api/skills/catalog${force ? "?refresh=1" : ""}`).then(
        async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
          return (body.skills ?? []) as CatalogExpert[];
        }
      ),
      fetch("/api/skills").then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
        return (body.skills ?? []) as InstalledExpert[];
      }),
    ]);
    if (seq !== loadSeqRef.current) return; // superseded by a newer load
    // The two sources degrade independently: a throttled catalog must not hide
    // the experts already on disk.
    if (cat.status === "fulfilled") {
      setCatalog(cat.value);
      setCatalogError(null);
    } else {
      setCatalog([]);
      setCatalogError(
        cat.reason instanceof Error
          ? cat.reason.message
          : "Failed to load catalog."
      );
    }
    if (inst.status === "fulfilled") {
      setInstalled(inst.value);
      setError(null);
    } else {
      setError(
        inst.reason instanceof Error
          ? inst.reason.message
          : "Failed to read installed skills."
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (name: string, kind: Busy) => {
      setBusy((b) => ({ ...b, [name]: kind }));
      setError(null);
      try {
        const res =
          kind === "uninstall"
            ? await fetch(`/api/skills?name=${encodeURIComponent(name)}`, {
                method: "DELETE",
              })
            : await fetch("/api/skills/install", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        await load();
        // The deployment's own view of what is installed changed too.
        refreshTeams();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[name];
          return next;
        });
      }
    },
    [load, refreshTeams]
  );

  const sections = buildExpertSections({ teams, catalog, installed });
  const isEmpty =
    !loading && sections.catalog.length === 0 && sections.other.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 py-5 sm:px-5 sm:py-6">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold sm:text-2xl">Experts</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Skills that also carry an actor definition, so the orchestrator
              can dispatch them to run a task on its own. Installing one is all
              it takes — there is nothing to switch on.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void load(true);
              // The installed-expert list is the deployment's answer, not the
              // catalog's — re-read both or a fresh install stays missing.
              refreshTeams();
            }}
            disabled={loading}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh"
          >
            {loading ? (
              <Loader2
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <RotateCw
                className="size-4"
                aria-hidden="true"
              />
            )}
          </button>
        </header>

        {catalogError && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Couldn&apos;t load the official catalog: {catalogError}. Experts
              already installed are listed below.
            </span>
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {sections.catalog.length > 0 && (
            <section>
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-tertiary">
                Official catalog
              </h3>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {sections.catalog.map((entry) => (
                  <SkillTile
                    key={entry.name}
                    icon={Users}
                    title={entry.title}
                    description={entry.description}
                    meta={
                      entry.fileCount ? `${entry.fileCount} files` : undefined
                    }
                    installed={entry.installed}
                    installedVersion={entry.installedVersion}
                    latestVersion={entry.latestVersion}
                    updateAvailable={entry.updateAvailable}
                    busy={busy[entry.name]}
                    actions={entry.installed ? activeBadge : undefined}
                    onOpen={() =>
                      setDetail({
                        name: entry.name,
                        title: entry.title,
                        description: entry.description,
                        version: entry.installedVersion ?? entry.latestVersion,
                        fileCount: entry.fileCount,
                        installed: entry.installed,
                      })
                    }
                    onInstall={() => void mutate(entry.name, "install")}
                    onUpdate={() => void mutate(entry.name, "update")}
                    onUninstall={
                      entry.removable
                        ? () =>
                            setUninstallTarget({
                              name: entry.name,
                              title: entry.title,
                            })
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {sections.other.length > 0 && (
            <section>
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-tertiary">
                Other installed experts
              </h3>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {sections.other.map((entry) => (
                  <SkillTile
                    key={entry.name}
                    icon={Users}
                    title={entry.title}
                    description={entry.description}
                    installed
                    busy={busy[entry.name]}
                    actions={activeBadge}
                    onOpen={() =>
                      setDetail({
                        name: entry.name,
                        title: entry.title,
                        description: entry.description,
                        installed: true,
                      })
                    }
                    onUninstall={
                      entry.removable
                        ? () =>
                            setUninstallTarget({
                              name: entry.name,
                              title: entry.title,
                            })
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {isEmpty && (
          <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <p className="text-sm font-medium">No experts yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
              An expert is a skill that also ships an actor definition. Install
              one from Research Skills and it shows up here — nothing ships with
              the backend by default.
            </p>
          </div>
        )}
      </div>

      <SkillDetailDialog
        skill={detail}
        preferExpert
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
            <DialogTitle>Uninstall expert?</DialogTitle>
            <DialogDescription>
              &ldquo;{uninstallTarget?.title ?? uninstallTarget?.name}&rdquo;
              will be removed from this Web UI, with its actor definition. A
              skill that came from the catalog can be installed again; one
              written locally cannot.
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
              onClick={() => {
                const target = uninstallTarget;
                setUninstallTarget(null);
                if (target) void mutate(target.name, "uninstall");
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
