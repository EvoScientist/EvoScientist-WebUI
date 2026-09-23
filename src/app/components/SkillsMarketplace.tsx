"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryState } from "nuqs";
import { Loader2, RotateCw } from "lucide-react";
import {
  SkillDetailDialog,
  type SkillDetailTarget,
} from "@/app/components/SkillDetailDialog";
import { SkillTile } from "@/app/components/SkillTile";
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

export function SkillsMarketplace() {
  const [, setView] = useQueryState("view");
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [other, setOther] = useState<SkillCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-skill in-flight action, keyed by skill name.
  const [busy, setBusy] = useState<
    Record<string, "install" | "uninstall" | "update">
  >({});
  // Skill whose detail dialog is open (null = closed).
  const [detail, setDetail] = useState<SkillDetailTarget | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<{
    name: string;
    title: string;
    isCatalog: boolean;
  } | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    setCatalogError(null);
    const [catRes, instRes] = await Promise.allSettled([
      fetch(`/api/skills/catalog${refresh ? "?refresh=1" : ""}`).then(
        async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || "Failed to load catalog");
          return (d.skills ?? []) as CatalogSkill[];
        }
      ),
      fetch("/api/skills").then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to load skills");
        return (d.skills ?? []) as SkillCard[];
      }),
    ]);

    // An entry whose `metadata.type` omits `skill` is an actor, not a tool:
    // it belongs under Experts only. Absence of the field means yes, so
    // nothing disappears just because an author never wrote it.
    const belongsHere = (s: { isSkill?: boolean }) => s.isSkill !== false;
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
        instRes.value.filter((s) => !catNames.has(s.name) && belongsHere(s))
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

  useEffect(() => {
    load();
  }, [load]);

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

  const confirmUninstall = async () => {
    if (!uninstallTarget) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    await uninstall(target.name, target.isCatalog);
  };

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
            onClick={() => load(true)}
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
              “{uninstallTarget?.title ?? uninstallTarget?.name}” will be
              removed from this Web UI. You can install it again later.
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
              Uninstall
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
      className="shrink-0 rounded-full border border-[var(--brand)] bg-[var(--brand-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand)] transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
      title="Also an expert — can be dispatched to run a task on its own"
    >
      Expert
    </button>
  );
}
