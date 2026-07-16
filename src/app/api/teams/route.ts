import { NextResponse } from "next/server";
import type { Team } from "@/lib/teams";

export const runtime = "nodejs";

// MOCK: until the backend exposes `GET /api/teams` (currently pending —
// only `EvoScientist/subagents/idea-brainstorm.yaml` exists, and the list
// endpoint that filters by `team: true` isn't implemented yet), the WebUI
// serves the catalog from a hardcoded list here.
//
// When the backend endpoint lands, delete this constant and replace the
// handler body with a proxy to the deployment (mirror
// `src/app/api/skills/catalog/route.ts` for the shape). Keep the returned
// JSON envelope stable — `{ teams: Team[] }` — so consumers of `useTeams`
// don't churn.
const TEAMS_MOCK: Team[] = [
  {
    name: "idea-brainstorm",
    description:
      "Multi-round research-idea brainstorm team. Grounds ideas in the literature, refines candidates across three research personas (innovator, pragmatist, critic) dispatched in parallel per round, ranks by ELO, and produces one detailed research proposal.",
    byline: "Research idea brainstormer",
    capability_tags: [
      "Iterative ideation",
      "Multi-persona refinement",
      "ELO-ranked proposals",
    ],
    avatar_hint: "lightbulb",
  },
];

export async function GET() {
  return NextResponse.json({ teams: TEAMS_MOCK });
}
