"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Puzzle,
  RotateCw,
  Trash2,
  Download,
  ArrowUpCircle,
} from "lucide-react";
import {
  SkillDetailDialog,
  type SkillDetailTarget,
} from "@/app/components/SkillDetailDialog";

interface SkillCard {
  name: string;
  title: string;
  description: string;
  dir: string;
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
}

export function SkillsMarketplace() {
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

    const cat = catRes.status === "fulfilled" ? catRes.value : [];
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
      setOther(instRes.value.filter((s) => !catNames.has(s.name)));
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
  const install = async (name: string, mode: "install" | "update" = "install") => {
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
    if (!window.confirm(`Uninstall the "${name}" skill?`)) return;
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1024px] px-6 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">Research Skills</h2>
            <p className="mt-1 text-sm text-muted-foreground">
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
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading skills…
          </div>
        ) : (
          <div className="space-y-8">
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-tertiary">
                Official catalog
              </h3>
              {catalogError ? (
                <p className="text-sm text-muted-foreground">{catalogError}</p>
              ) : catalog.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No skills found in the catalog.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {catalog.map((s) => (
                    <SkillTile
                      key={s.name}
                      title={s.title}
                      description={s.description}
                      meta={`${s.fileCount} file${s.fileCount === 1 ? "" : "s"}`}
                      installed={s.installed}
                      installedVersion={s.installedVersion}
                      latestVersion={s.latestVersion}
                      updateAvailable={s.updateAvailable}
                      busy={busy[s.name]}
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
                      onUninstall={() => uninstall(s.name, true)}
                    />
                  ))}
                </div>
              )}
            </section>

            {other.length > 0 && (
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-tertiary">
                  Other installed skills
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {other.map((s) => (
                    <SkillTile
                      key={s.name}
                      title={s.title}
                      description={s.description}
                      installed
                      busy={busy[s.name]}
                      onOpen={() =>
                        setDetail({
                          name: s.name,
                          title: s.title,
                          description: s.description,
                          installed: true,
                        })
                      }
                      onUninstall={() => uninstall(s.name, false)}
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
    </div>
  );
}

function SkillTile({
  title,
  description,
  meta,
  installed,
  installedVersion,
  latestVersion,
  updateAvailable,
  busy,
  onOpen,
  onInstall,
  onUpdate,
  onUninstall,
}: {
  title: string;
  description: string;
  meta?: string;
  installed: boolean;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  busy?: "install" | "uninstall" | "update";
  onOpen?: () => void;
  onInstall?: () => void;
  onUpdate?: () => void;
  onUninstall?: () => void;
}) {
  const versionLabel = installed
    ? installedVersion && `v${installedVersion}`
    : latestVersion && `v${latestVersion}`;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4">
      <button
        type="button"
        onClick={onOpen}
        className="-m-1 flex items-start gap-3 rounded-md p-1 text-left transition-colors hover:bg-muted/50"
        title="View details"
      >
        <Puzzle
          className="mt-0.5 size-5 shrink-0 text-[var(--brand)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="break-words font-medium">{title}</h3>
            {versionLabel && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {versionLabel}
              </span>
            )}
            {meta && (
              <span className="shrink-0 text-xs text-muted-foreground">
                · {meta}
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">
            {description || "No description."}
          </p>
        </div>
      </button>
      <div className="mt-3 flex items-center justify-end gap-2">
        {installed && updateAvailable && (
          <button
            type="button"
            onClick={onUpdate}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            title={
              latestVersion ? `Update to v${latestVersion}` : "Update"
            }
          >
            {busy === "update" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUpCircle className="size-3.5" aria-hidden="true" />
            )}
            {busy === "update"
              ? "Updating…"
              : latestVersion
                ? `Update → v${latestVersion}`
                : "Update"}
          </button>
        )}
        {installed ? (
          <button
            type="button"
            onClick={onUninstall}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            {busy === "uninstall" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-3.5" aria-hidden="true" />
            )}
            {busy === "uninstall" ? "Removing…" : "Uninstall"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "install" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-3.5" aria-hidden="true" />
            )}
            {busy === "install" ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}
