// Experts ("teams" on the wire) exposed by the deployment's `GET /api/teams`.
//
// An expert is an ordinary skill whose directory also carries an `EXPERT.md`:
// that file's presence is the declaration, and its body is the persona the
// backend runs the expert with. The gallery only ever gets identity fields —
// the backend deliberately does not project the SKILL.md body, tool list or
// filesystem path.

export interface TeamEntry {
  name: string;
  description: string;
}

// A catalog row, narrowed to what the Experts view needs. Mirrors the shape
// `/api/skills/catalog` returns, plus the `isExpert` flag.
export interface CatalogExpert {
  name: string;
  title: string;
  description: string;
  fileCount?: number;
  installed: boolean;
  isExpert: boolean;
  latestVersion?: string;
  installedVersion?: string;
  updateAvailable: boolean;
}

// An installed skill as `/api/skills` reports it, plus the `isExpert` flag.
export interface InstalledExpert {
  name: string;
  title: string;
  description: string;
  isExpert: boolean;
}

/** A catalog row as the Experts view renders it: `installed` may have been
 *  promoted from the deployment's view, so `removable` carries whether the
 *  browser can actually delete it. */
export type CatalogExpertRow = CatalogExpert & { removable: boolean };

export interface ExpertSections {
  catalog: CatalogExpertRow[];
  other: {
    name: string;
    title: string;
    description: string;
    /** Whether uninstalling is actually possible. Removal deletes from the
     *  global tier the Next.js route scans; an expert only the deployment can
     *  see (builtin or workspace tier) is not there, so offering the action
     *  would advertise something that can only fail. */
    removable: boolean;
  }[];
}

export function buildExpertSections(input: {
  teams: TeamEntry[];
  catalog: CatalogExpert[];
  installed: InstalledExpert[];
}): ExpertSections {
  const teamNames = new Set(input.teams.map((team) => team.name));
  const localByName = new Map(input.installed.map((e) => [e.name, e]));

  const catalog = input.catalog
    .filter((entry) => entry.isExpert)
    .map((entry) => {
      // `entry.installed` and the local scan describe the same directories,
      // but they arrive as two separate requests and one can be a moment
      // older. Take the union rather than trusting either alone.
      const locallyPresent = entry.installed || localByName.has(entry.name);
      return {
        ...entry,
        // The deployment sees tiers the browser cannot (workspace, builtin),
        // so a name it reports is installed even when neither scan saw it.
        installed: locallyPresent || teamNames.has(entry.name),
        // Removal only reaches the tier the browser scans: keep the local
        // answer, never the deployment-promoted one.
        removable: locallyPresent,
      };
    });
  const catalogNames = new Set(catalog.map((entry) => entry.name));

  // The deployment is authoritative for what it can dispatch, but it is not
  // the only source: a local skill carrying an EXPERT.md is an expert even
  // while `/api/teams` is unreachable, so it is listed either way.
  const names = new Set<string>();
  for (const team of input.teams) names.add(team.name);
  for (const local of input.installed) {
    if (local.isExpert) names.add(local.name);
  }

  const teamByName = new Map(input.teams.map((t) => [t.name, t]));
  const other = [...names]
    .filter((name) => !catalogNames.has(name))
    .map((name) => {
      const local = localByName.get(name);
      const team = teamByName.get(name);
      return {
        name,
        title: local?.title || name,
        description: local?.description || team?.description || "",
        removable: local !== undefined,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  return { catalog, other };
}

export function parseTeams(value: unknown): TeamEntry[] {
  if (!value || typeof value !== "object") return [];
  const teams = (value as Record<string, unknown>).teams;
  if (!Array.isArray(teams)) return [];
  const entries: TeamEntry[] = [];
  for (const raw of teams) {
    if (!raw || typeof raw !== "object") continue;
    const { name, description } = raw as Record<string, unknown>;
    if (typeof name !== "string" || !name) continue;
    entries.push({
      name,
      description: typeof description === "string" ? description : "",
    });
  }
  return entries;
}
