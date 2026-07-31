"use client";

import { useMemo } from "react";
import { CornerUpLeft } from "lucide-react";
import type { EnrichedAsyncTask } from "@/lib/asyncAgents";
import { ASYNC_STATUS_META, normalizeAsyncStatus } from "@/lib/asyncAgents";
import { formatTeamName } from "@/lib/teams";
import { useTeams } from "@/app/hooks/useTeams";
import { iconForHint } from "@/app/components/ExpertsMarketplace";
import { cn } from "@/lib/utils";

interface PersonaChipStripProps {
  /** Invited teams from `useChatContext().activeTeams`. May overlap with
   *  `tasks` — deduped by name (task wins if both are present). */
  activeTeams: string[];
  /** Enriched async tasks from `useAsyncAgents(threadId)`. Provides the
   *  status dot and the sub-thread id used for focus routing. */
  tasks: EnrichedAsyncTask[];
  /** The sub-thread currently focused, or null when the main conversation
   *  is showing. Drives the "active" chip highlight. */
  focusedAgentThreadId: string | null;
  /** Chip click when the persona has a sub-thread — focuses it. Composer
   *  swaps the messages area for `<PersonaFocusView>`. */
  onFocus: (subThreadId: string) => void;
  /** Chip click when the persona is invited-only (no sub-thread yet) — opens
   *  the Experts marketplace so the user can dismiss / re-summon. */
  onManage: () => void;
}

interface PersonaEntry {
  name: string;
  task: EnrichedAsyncTask | null;
}

/**
 * Persona chip row rendered just above the composer while at least one
 * expert is invited or running. Each chip is one deduped `agent_name`:
 *
 *   ┌────────────────────────────────┐
 *   │ [icon] Idea Brainstorm  · dot  │  ← dot = task status (running/done/…)
 *   └────────────────────────────────┘
 *
 * Chip click routes based on whether the persona has a sub-thread:
 *  - Dispatched (task exists) → focus its sub-thread via `onFocus`.
 *  - Invited-only (activeTeams entry, no task) → open the Experts
 *    marketplace via `onManage` so the user can dismiss or re-summon.
 *
 * Dismissal from the chip itself is deliberately not offered: the chip is
 * a "focus" affordance, and adding an X here would collide with the
 * marketplace's Summon/Dismiss CTA. Users dismiss from the marketplace.
 */
export function PersonaChipStrip({
  activeTeams,
  tasks,
  focusedAgentThreadId,
  onFocus,
  onManage,
}: PersonaChipStripProps) {
  // Cheap catalog lookup so we can decorate chips with the team's icon
  // hint. Failures are silent — chips fall back to the generic bot icon.
  const { teams } = useTeams();
  const hintByName = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const t of teams) m.set(t.name, t.avatar_hint);
    return m;
  }, [teams]);

  const invitedSet = useMemo(() => new Set(activeTeams), [activeTeams]);
  const entries = useMemo<PersonaEntry[]>(() => {
    const byName = new Map<string, PersonaEntry>();
    for (const name of activeTeams) {
      byName.set(name, { name, task: null });
    }
    // Task entries override (a running task supersedes the invited-only
    // shape). `useAsyncAgents` returns tasks newest-first — a plain forward
    // .set() loop would overwrite with progressively older tasks, so the
    // FIRST write per name is the freshest run. Only fill if unset.
    for (const task of tasks) {
      const existing = byName.get(task.agent_name);
      if (!existing || existing.task === null) {
        byName.set(task.agent_name, { name: task.agent_name, task });
      }
    }
    return Array.from(byName.values());
  }, [activeTeams, tasks]);

  if (entries.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-1.5"
      aria-label="Active experts"
    >
      <CornerUpLeft
        className="size-3 rotate-90 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="text-xs text-muted-foreground">Experts</span>
      {entries.map((entry) => (
        <PersonaChip
          key={entry.name}
          entry={entry}
          hint={hintByName.get(entry.name)}
          invited={invitedSet.has(entry.name)}
          focused={
            entry.task !== null && entry.task.thread_id === focusedAgentThreadId
          }
          onClick={() => {
            if (entry.task) {
              onFocus(entry.task.thread_id);
            } else {
              onManage();
            }
          }}
        />
      ))}
    </div>
  );
}

function PersonaChip({
  entry,
  hint,
  invited,
  focused,
  onClick,
}: {
  entry: PersonaEntry;
  hint: string | undefined;
  invited: boolean;
  focused: boolean;
  onClick: () => void;
}) {
  const Icon = iconForHint(hint);
  const title = formatTeamName(entry.name);
  const statusMeta = entry.task
    ? ASYNC_STATUS_META[normalizeAsyncStatus(entry.task.liveStatus)]
    : null;
  // Dismissed = has a task but no longer in activeTeams. Chip stays so the
  // user can review the sub-thread; dot goes grey (non-pulsing) to signal
  // "leftover run — the expert is no longer on the roster and can't take
  // new work". Overrides the live liveStatus dot for dismissed chips.
  const dismissed = entry.task !== null && !invited;
  const dotClass = dismissed ? "bg-muted-foreground" : statusMeta?.dot ?? "";
  const dotPulse = dismissed ? false : statusMeta?.pulse ?? false;
  const statusLabel = statusMeta?.label ?? "";
  const label = entry.task
    ? dismissed
      ? statusLabel
        ? `${statusLabel} · Dismissed`
        : "Dismissed"
      : statusLabel
    : "Invited";
  const semantic = entry.task
    ? focused
      ? `Focused: ${title}`
      : `Focus ${title}`
    : `Manage ${title}`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={focused}
      aria-label={label ? `${semantic} (${label})` : semantic}
      title={label ? `${semantic} (${label})` : semantic}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        focused
          ? "border-[var(--brand)]/60 bg-[var(--brand)]/10 text-foreground"
          : "border-border bg-card text-foreground hover:bg-accent",
        dismissed && !focused && "text-muted-foreground"
      )}
    >
      <span
        className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[var(--brand)]"
        aria-hidden="true"
      >
        <Icon className="size-2.5" />
      </span>
      <span>{title}</span>
      {statusMeta && (
        <span
          className={cn(
            "ml-0.5 size-2 rounded-full",
            dotClass,
            dotPulse && "animate-pulse"
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
