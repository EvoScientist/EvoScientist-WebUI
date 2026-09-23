// The card used by both skill galleries. Research Skills and Experts render the
// same tile: an expert IS a skill, so it keeps one component tree rather than
// growing a parallel set of types. The `actions` slot is the only thing the
// two views differ by — the "Expert" marker on one side, Active on the other.

import type { ReactNode } from "react";
import {
  ArrowUpCircle,
  Download,
  Loader2,
  Puzzle,
  Trash2,
  type LucideIcon,
} from "lucide-react";

export function SkillTile({
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
  actions,
  icon: Icon = Puzzle,
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
  /** Rendered next to the install controls — e.g. the "Expert" marker, or
   *  the Active state in the Experts view. */
  actions?: ReactNode;
  /** Leading glyph. Defaults to the skill icon; the Experts view passes its
   *  own so the two galleries read apart at a glance. */
  icon?: LucideIcon;
}) {
  const versionLabel = installed
    ? installedVersion && `v${installedVersion}`
    : latestVersion && `v${latestVersion}`;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        onClick={onOpen}
        className="-m-1 flex items-start gap-2.5 rounded-md p-1 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        title="View details"
      >
        <Icon
          className="mt-0.5 size-5 shrink-0 text-[var(--brand)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="break-words text-lg font-medium leading-tight">
              {title}
            </h3>
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
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
            {description || "No description."}
          </p>
        </div>
      </button>
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
        {actions}
        {installed && updateAvailable && (
          <button
            type="button"
            onClick={onUpdate}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-solid)] px-2.5 py-1 text-xs font-medium text-[var(--brand-foreground)] transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            title={latestVersion ? `Update to v${latestVersion}` : "Update"}
          >
            {busy === "update" ? (
              <Loader2
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <ArrowUpCircle
                className="size-3.5"
                aria-hidden="true"
              />
            )}
            {busy === "update"
              ? "Updating…"
              : latestVersion
              ? `Update → v${latestVersion}`
              : "Update"}
          </button>
        )}
        {installed ? (
          !onUninstall ? null : (
            <button
              type="button"
              onClick={onUninstall}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy === "uninstall" ? (
                <Loader2
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Trash2
                  className="size-3.5"
                  aria-hidden="true"
                />
              )}
              {busy === "uninstall" ? "Removing…" : "Uninstall"}
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-solid)] px-2.5 py-1 text-xs font-medium text-[var(--brand-foreground)] transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy === "install" ? (
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
            {busy === "install" ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}
