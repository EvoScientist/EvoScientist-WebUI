"use client";

import { useMemo, useState } from "react";
import {
  Bot,
  FlaskConical,
  Lightbulb,
  Loader2,
  Microscope,
  RotateCw,
  Rocket,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useTeams } from "@/app/hooks/useTeams";
import { useChatContext } from "@/providers/ChatProvider";
import { formatTeamName, type Team } from "@/lib/teams";
import { cn } from "@/lib/utils";
import { ExpertDetailDialog } from "@/app/components/ExpertDetailDialog";

// Map the backend's `avatar_hint` string to a concrete lucide icon. Unknown
// hints fall back to a generic bot. Kept as a plain switch rather than a
// dynamic lookup so the icon set is easy to audit and tree-shake.
export function iconForHint(hint: string | undefined): LucideIcon {
  switch (hint) {
    case "lightbulb":
      return Lightbulb;
    case "microscope":
      return Microscope;
    case "flask":
      return FlaskConical;
    case "rocket":
      return Rocket;
    default:
      return Bot;
  }
}

interface ExpertsMarketplaceProps {
  // Called after a Summon click so the caller can leave the marketplace and
  // return to the chat view.
  onSummoned?: () => void;
}

/**
 * Full-panel Experts marketplace. Fetches the catalog via `useTeams`,
 * reads/writes the per-thread summoned list via `useChatContext` (seeded from
 * thread metadata on mount, written through on every `setActiveTeams`).
 *
 * v1 UX is single-active — clicking Summon on team X replaces the current
 * selection with `[x]`; clicking Dismiss on the active team clears to `[]`.
 * The underlying state is `string[]` so future multi-select is a UX change
 * only.
 */
export function ExpertsMarketplace({ onSummoned }: ExpertsMarketplaceProps) {
  const { teams, loaded, error, refresh } = useTeams();
  const { activeTeams, setActiveTeams } = useChatContext();
  const [detail, setDetail] = useState<Team | null>(null);
  const [query, setQuery] = useState("");

  const activeSet = useMemo(() => new Set(activeTeams), [activeTeams]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((team) => {
      const hay = [
        team.name,
        formatTeamName(team.name),
        team.description,
        team.byline ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [teams, query]);

  const summon = async (team: Team) => {
    const alreadyActive = activeSet.has(team.name);
    await setActiveTeams(alreadyActive ? [] : [team.name]);
    setDetail(null);
    if (!alreadyActive) onSummoned?.();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-4 py-5 sm:px-5 sm:py-6">
        <header className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold sm:text-2xl">Experts</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Summon an expert team to bias EvoScientist toward their specialty.
              One expert at a time; dismiss to release.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search experts…"
                aria-label="Search experts"
                className="h-9 w-56 rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <button
              type="button"
              onClick={() => refresh()}
              disabled={!loaded}
              aria-label="Refresh experts"
              title="Refresh"
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <RotateCw
                className={cn("size-4", !loaded && "animate-spin")}
                aria-hidden="true"
              />
            </button>
          </div>
        </header>

        {error && (
          <p
            role="alert"
            className="mb-4 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {!loaded && !error && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Loader2
              className="size-4 animate-spin"
              aria-hidden="true"
            />
            Loading experts…
          </div>
        )}

        {loaded && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {teams.length === 0
              ? "No experts available."
              : "No experts match that search."}
          </p>
        )}

        {loaded && filtered.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((team) => (
              <ExpertCard
                key={team.name}
                team={team}
                isActive={activeSet.has(team.name)}
                onOpen={() => setDetail(team)}
              />
            ))}
          </div>
        )}
      </div>

      <ExpertDetailDialog
        team={detail}
        isActive={detail ? activeSet.has(detail.name) : false}
        onClose={() => setDetail(null)}
        onSummon={() => detail && summon(detail)}
      />
    </div>
  );
}

function ExpertCard({
  team,
  isActive,
  onOpen,
}: {
  team: Team;
  isActive: boolean;
  onOpen: () => void;
}) {
  const Icon = iconForHint(team.avatar_hint);
  const title = formatTeamName(team.name);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${title} details`}
      className={cn(
        "group flex flex-col rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? "border-[var(--brand)]/60 bg-[var(--brand)]/5"
          : "hover:border-[var(--brand)]/30 border-border bg-card hover:bg-accent/40"
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md",
            isActive
              ? "bg-[var(--brand-solid)] text-[var(--brand-foreground)]"
              : "group-hover:bg-[var(--brand)]/10 bg-muted text-[var(--brand)]"
          )}
          aria-hidden="true"
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold leading-tight">
              {title}
            </h3>
            {isActive && (
              <span className="rounded-full bg-[var(--brand-solid)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--brand-foreground)]">
                Summoned
              </span>
            )}
          </div>
          {team.byline && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {team.byline}
            </p>
          )}
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">
        {team.description}
      </p>
      {team.capability_tags && team.capability_tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {team.capability_tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
