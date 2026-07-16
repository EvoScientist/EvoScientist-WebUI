"use client";

import {
  Bot,
  FlaskConical,
  Lightbulb,
  Loader2,
  Microscope,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useTeams } from "@/app/hooks/useTeams";
import { useChatContext } from "@/providers/ChatProvider";
import { formatTeamName, type Team } from "@/lib/teams";
import { cn } from "@/lib/utils";

// Map the backend's `avatar_hint` string to a concrete lucide icon. Unknown
// hints fall back to a generic bot. Kept as a plain switch rather than a
// dynamic lookup so the icon set is easy to audit and tree-shake.
function iconForHint(hint: string | undefined): LucideIcon {
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

/**
 * Gallery of user-summonable teams. Fetches the catalog via `useTeams`,
 * reads/writes the per-thread summoned list via `useChatContext` (which is
 * seeded from thread metadata on mount and written through on every
 * setActiveTeams). v1 UX is single-active — clicking Summon on team X
 * replaces the current selection with `[x]`; Unsummon clears to `[]`. The
 * underlying state is `string[]` so future multi-select is a UX change only.
 */
export function ExpertsPanel() {
  const { teams, loaded, error, refresh } = useTeams();
  const { activeTeams, setActiveTeams } = useChatContext();

  // O(1) membership checks per card render.
  const activeSet = useMemo(() => new Set(activeTeams), [activeTeams]);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2
          className="mr-2 size-4 animate-spin"
          aria-hidden="true"
        />
        Loading experts…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <p>Couldn&apos;t load experts.</p>
        <p className="text-xs">{error}</p>
        <button
          type="button"
          onClick={() => refresh()}
          className="mt-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No experts available.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {teams.map((team) => {
        const isActive = activeSet.has(team.name);
        return (
          <TeamCard
            key={team.name}
            team={team}
            isActive={isActive}
            onToggle={() => void setActiveTeams(isActive ? [] : [team.name])}
          />
        );
      })}
    </div>
  );
}

function TeamCard({
  team,
  isActive,
  onToggle,
}: {
  team: Team;
  isActive: boolean;
  onToggle: () => void;
}) {
  const Icon = iconForHint(team.avatar_hint);
  const title = formatTeamName(team.name);
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border p-3 transition-colors",
        isActive
          ? "border-[var(--brand)]/60 bg-[var(--brand)]/5"
          : "border-border bg-card"
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className="mt-0.5 size-5 shrink-0 text-[var(--brand)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-lg font-medium leading-tight">
            {title}
          </h3>
          {team.byline && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {team.byline}
            </p>
          )}
          <p className="mt-1.5 line-clamp-3 text-sm leading-6 text-muted-foreground">
            {team.description}
          </p>
          {team.capability_tags && team.capability_tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
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
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            isActive
              ? "border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              : "bg-[var(--brand-solid)] text-[var(--brand-foreground)] hover:opacity-90"
          )}
        >
          {isActive ? "Unsummon" : "Summon"}
        </button>
      </div>
    </div>
  );
}
