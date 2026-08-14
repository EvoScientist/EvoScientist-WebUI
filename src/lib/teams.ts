// "Teams" are curated user-summonable subagents shipped by the backend as YAML
// under `EvoScientist/subagents/*.yaml` with `team: true`. The backend will
// eventually expose them at `GET /api/teams` and read the selection back on
// each run via `configurable.active_teams: list[str]` (see
// EvoScientist middleware `ActiveTeamMiddleware`, and the joint design note
// `.backend-ref/notes/teams-and-workflows/teams-and-workflows-design.md`).
//
// This file owns the client-side type surface and the metadata key we persist
// per-thread. Mirrors the shape of `modelCommand.ts` — same reason: the type +
// storage key belong next to the feature, not buried in a hook.

/** Thread-metadata key carrying the per-thread summoned team names.
 *
 *  Persisting to thread metadata (rather than localStorage) is the same
 *  choice we made for `model_override`: the selection follows the
 *  conversation, not the browser tab. Backend stays stateless w.r.t. this
 *  key — it only reads `configurable.active_teams` on the run config, which
 *  `useChat.buildRunConfig` will populate from local state that is itself
 *  seeded from this metadata key on thread switch. */
export const ACTIVE_TEAMS_METADATA_KEY = "active_teams";

/** Team card metadata surfaced by `GET /api/teams`. Matches the YAML fields
 *  the backend exposes for team-tagged subagents. All display fields except
 *  `name` and `description` are optional so the card degrades gracefully
 *  before backend schema evolution catches up. */
export interface Team {
  /** Subagent name as it appears in the YAML key (e.g. "idea-brainstorm").
   *  This is the string echoed back to the backend on every run via
   *  `configurable.active_teams`. */
  name: string;
  /** Long-form description shown in the gallery card body. */
  description: string;
  /** One-line persona name shown under the title (like a byline). */
  byline?: string;
  /** 2-3 short capability chips shown on the card. */
  capability_tags?: string[];
  /** Icon hint (e.g. "lightbulb", "microscope"). The client maps this to a
   *  lucide-react icon; unknown hints fall back to a generic bot icon. */
  avatar_hint?: string;
}

/** Team `name` values are backend identifiers (kebab-case, e.g.
 *  "idea-brainstorm"). Present them as Title Case so gallery cards and the
 *  composer chip read like product surfaces, not JSON keys. */
export function formatTeamName(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
