// AutoSkills drafts ("proposals") from the core's
// GET /api/autoskills/proposals: the wire types, the parser and the words
// and groupings the review pages use.

import { RELAY_REFUSAL_TEXT } from "@/lib/projectActions";
import { compareProjects, type Project } from "@/lib/projects";
import type { SettingsWriteAccess } from "@/lib/settings";

export type DraftStatus = "pending" | "approved" | "rejected";
export type DraftScope = "workspace" | "global";

export interface DraftFile {
  path: string;
  size: number;
  installed: boolean;
}

export interface Draft {
  proposal_id: string;
  skill_name: string;
  description: string;
  operation: "create" | "update";
  target_skill_name: string | null;
  scope: DraftScope;
  submitted_scope: string | null;
  status: DraftStatus;
  workspace_dir: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  approved_by: "user" | "auto" | null;
  rejected_at: string | null;
  approved_skill_path: string | null;
  approved_skill_present: boolean | null;
  source_observation_ids: string[];
  skill_md: string;
  skill_md_truncated: boolean;
  rationale_md: string;
  rationale_md_truncated: boolean;
  files: DraftFile[];
  install_target: string | null;
  install_base: string | null;
  install_error: string | null;
}

export interface DraftCounts {
  pending: number;
  approved: number;
  rejected: number;
}

export interface DraftList {
  drafts: Draft[];
  counts: DraftCounts;
  byProject: Record<string, DraftCounts>;
}

export interface DraftGroup {
  project: Project;
  label: string;
  drafts: Draft[];
}

/** The settings the AutoSkills status line and sub-page read and save. */
export const AUTOSKILLS_FIELDS: readonly string[] = [
  "memory_skill_synthesis_enabled",
  "memory_skill_synthesis_mode",
  "memory_skill_synthesis_cadence",
  "memory_skill_synthesis_time",
];

const STATUSES: readonly string[] = ["pending", "approved", "rejected"];

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseCounts(value: unknown): DraftCounts | null {
  if (!isPlainObject(value)) return null;
  const { pending, approved, rejected } = value;
  if (!validCount(pending) || !validCount(approved) || !validCount(rejected)) {
    return null;
  }
  return { pending, approved, rejected };
}

function parseDraft(row: unknown): Draft | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.proposal_id !== "string" ||
    typeof r.skill_name !== "string" ||
    typeof r.workspace_dir !== "string" ||
    typeof r.status !== "string" ||
    !STATUSES.includes(r.status) ||
    (r.operation !== "create" && r.operation !== "update") ||
    (r.scope !== "workspace" && r.scope !== "global")
  ) {
    return null;
  }
  const files: DraftFile[] = [];
  if (Array.isArray(r.files)) {
    for (const f of r.files) {
      const file = f as Record<string, unknown> | null;
      if (typeof file?.path !== "string") continue;
      files.push({
        path: file.path,
        size: count(file.size),
        installed: file.installed === true,
      });
    }
  }
  return {
    proposal_id: r.proposal_id,
    skill_name: r.skill_name,
    description: text(r.description),
    operation: r.operation,
    target_skill_name: textOrNull(r.target_skill_name),
    scope: r.scope,
    submitted_scope: textOrNull(r.submitted_scope),
    status: r.status as DraftStatus,
    workspace_dir: r.workspace_dir,
    created_at: text(r.created_at),
    updated_at: text(r.updated_at),
    approved_at: textOrNull(r.approved_at),
    approved_by:
      r.approved_by === "user" || r.approved_by === "auto"
        ? r.approved_by
        : null,
    rejected_at: textOrNull(r.rejected_at),
    approved_skill_path: textOrNull(r.approved_skill_path),
    approved_skill_present:
      typeof r.approved_skill_present === "boolean"
        ? r.approved_skill_present
        : null,
    source_observation_ids: Array.isArray(r.source_observation_ids)
      ? r.source_observation_ids.filter(
          (id): id is string => typeof id === "string"
        )
      : [],
    skill_md: text(r.skill_md),
    skill_md_truncated: r.skill_md_truncated === true,
    rationale_md: text(r.rationale_md),
    rationale_md_truncated: r.rationale_md_truncated === true,
    files,
    install_target: textOrNull(r.install_target),
    install_base: textOrNull(r.install_base),
    install_error: textOrNull(r.install_error),
  };
}

/** The drafts in a proposals body, or null when it isn't one. */
export function parseDraftList(body: unknown): DraftList | null {
  const b = body as {
    proposals?: unknown;
    counts?: unknown;
    by_project?: unknown;
  } | null;
  if (!b || !Array.isArray(b.proposals)) return null;
  const counts = parseCounts(b.counts);
  if (!counts) return null;
  if (b.by_project !== undefined && !isPlainObject(b.by_project)) return null;
  const drafts: Draft[] = [];
  for (const row of b.proposals) {
    const d = parseDraft(row);
    if (d) drafts.push(d);
  }
  const byProject: Record<string, DraftCounts> = {};
  if (b.by_project) {
    for (const [key, value] of Object.entries(b.by_project)) {
      const c = parseCounts(value);
      if (c) byProject[key] = c;
    }
  }
  return { drafts, counts, byProject };
}

function segments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

function lastSegment(path: string): string {
  return segments(path).pop() ?? path;
}

/** Each project's label: its name, with the parent folder added to names two
 *  or more projects share, and the full key when that still isn't unique. */
export function projectLabels(
  projects: readonly Project[]
): Map<string, string> {
  const byName = new Map<string, Project[]>();
  for (const p of projects) {
    byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  }
  const withParent = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const p of projects) {
    if ((byName.get(p.name)?.length ?? 0) < 2) continue;
    const parent = segments(p.key).slice(-2, -1)[0];
    const label = parent ? `${p.name} (${parent})` : p.key;
    labels.set(p.key, label);
    withParent.set(label, (withParent.get(label) ?? 0) + 1);
  }
  for (const p of projects) {
    const label = labels.get(p.key);
    if (label === undefined) labels.set(p.key, p.name);
    else if ((withParent.get(label) ?? 0) > 1) labels.set(p.key, p.key);
  }
  const shared = new Map<string, number>();
  for (const label of labels.values()) {
    shared.set(label, (shared.get(label) ?? 0) + 1);
  }
  for (const [key, label] of labels) {
    if ((shared.get(label) ?? 0) > 1) labels.set(key, key);
  }
  return labels;
}

/** A project's label, or its folder name for a key the map lacks. */
export function labelFor(key: string, labels: Map<string, string>): string {
  return labels.get(key) ?? lastSegment(key);
}

/** A timestamp's milliseconds, or null when it doesn't parse. */
export function timeOf(value: string): number | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function newestFirst(a: Draft, b: Draft): number {
  const ta = timeOf(a.created_at);
  const tb = timeOf(b.created_at);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  return a.skill_name.localeCompare(b.skill_name);
}

/** The drafts of one status by project, in project order. Pending lists
 *  every project; the other two only those with drafts. */
export function groupDrafts(
  list: DraftList,
  projects: readonly Project[],
  status: DraftStatus
): DraftGroup[] {
  const all = [...projects];
  const known = new Set(all.map((p) => p.key));
  for (const d of list.drafts) {
    if (d.status === status && !known.has(d.workspace_dir)) {
      known.add(d.workspace_dir);
      all.push({
        key: d.workspace_dir,
        name: lastSegment(d.workspace_dir),
        missing: false,
      });
    }
  }
  all.sort(compareProjects);
  const labels = projectLabels(all);
  const groups: DraftGroup[] = [];
  for (const project of all) {
    const drafts = list.drafts
      .filter((d) => d.status === status && d.workspace_dir === project.key)
      .sort(newestFirst);
    if (status !== "pending" && drafts.length === 0) continue;
    groups.push({ project, label: labelFor(project.key, labels), drafts });
  }
  return groups;
}

/** What the banner above the skills says: the pending total, its split by
 *  project and when the newest draft came. */
export function bannerSummary(
  list: DraftList,
  projects: readonly Project[]
): {
  pending: number;
  split: Array<{ label: string; count: number }>;
  latest: string | null;
} {
  const keys = new Set(projects.map((p) => p.key));
  const all = [...projects];
  for (const key of Object.keys(list.byProject)) {
    if (!keys.has(key))
      all.push({ key, name: lastSegment(key), missing: false });
  }
  all.sort(compareProjects);
  const labels = projectLabels(all);
  const split: Array<{ label: string; count: number }> = [];
  for (const p of all) {
    const n = list.byProject[p.key]?.pending ?? 0;
    if (n > 0) split.push({ label: labelFor(p.key, labels), count: n });
  }
  let latest: string | null = null;
  let latestTime = -Infinity;
  for (const d of list.drafts) {
    if (d.status !== "pending") continue;
    const t = timeOf(d.created_at);
    if (t !== null && t > latestTime) {
      latestTime = t;
      latest = d.created_at;
    }
  }
  return { pending: list.counts.pending, split, latest };
}

/** The line under a decided draft: where it went, or why it didn't. */
export function installedLabel(
  draft: Draft,
  labels: Map<string, string>
): string {
  if (draft.status === "rejected") {
    // Not "never again": the core marks the cluster of observations as
    // processed by its hash, which a new related observation changes.
    return "Rejected. EvoMemory won't suggest it again unless the observations behind it change.";
  }
  if (draft.status !== "approved") return "";
  if (draft.approved_skill_present === false) return "No longer installed";
  if (draft.scope === "global") return "Installed into all projects (global)";
  return `Installed into ${labelFor(draft.workspace_dir, labels)}/skills`;
}

const CADENCE_TEXT: Record<string, string> = {
  nightly: "runs every night",
  weekly: "runs weekly",
  monthly: "runs monthly",
};

const NO_FIELDS: ReadonlySet<string> = new Set();

/** The one-line summary of the AutoSkills settings, or null before they
 *  are read. `settings` holds the saved values; `shadowed` names the fields
 *  an override hides in the running backend (an environment variable; what
 *  it says isn't sent). Such a value is never stated: with on / off hidden
 *  the line says only that, and a hidden mode, cadence or time is left out. */
export function statusLine(
  settings: Record<string, unknown> | undefined,
  shadowed: ReadonlySet<string> = NO_FIELDS
): string | null {
  if (!settings) return null;
  if (shadowed.has("memory_skill_synthesis_enabled")) {
    return "AutoSkills is set by an environment variable on the machine that runs EvoScientist.";
  }
  if (settings.memory_skill_synthesis_enabled === false) {
    return "AutoSkills is off in every project";
  }
  const parts = ["Every project"];
  const cadence = shadowed.has("memory_skill_synthesis_cadence")
    ? null
    : CADENCE_TEXT[String(settings.memory_skill_synthesis_cadence)] ??
      CADENCE_TEXT.weekly;
  const rawTime = settings.memory_skill_synthesis_time;
  const time = shadowed.has("memory_skill_synthesis_time")
    ? null
    : typeof rawTime === "string" && rawTime
    ? rawTime
    : "03:00";
  if (cadence && time) parts.push(`${cadence} at ${time}`);
  else if (cadence) parts.push(cadence);
  else if (time) parts.push(`runs at ${time}`);
  if (!shadowed.has("memory_skill_synthesis_mode")) {
    parts.push(
      settings.memory_skill_synthesis_mode === "auto"
        ? "drafts install automatically"
        : "you review each draft"
    );
  }
  return parts.join(" · ");
}

/** The installed skills that came from approved drafts, by folder name. */
export function fromMemorySkills(
  list: DraftList,
  projectKey: string | null
): {
  global: Map<string, "create" | "update">;
  project: Map<string, "create" | "update">;
} {
  const global = new Map<string, "create" | "update">();
  const project = new Map<string, "create" | "update">();
  for (const d of list.drafts) {
    if (d.status !== "approved" || d.approved_skill_present === false) continue;
    if (!d.approved_skill_path) continue;
    const name = lastSegment(d.approved_skill_path);
    if (d.scope === "global") global.set(name, d.operation);
    else if (projectKey !== null && d.workspace_dir === projectKey) {
      project.set(name, d.operation);
    }
  }
  return { global, project };
}

/** Whether approving an update at its recorded scope gives a project its
 *  own copy of a global skill: the core writes it to another folder
 *  (`install_target`) than the one it starts from (`install_base`), and the
 *  global skill stays. Any other update replaces the installed skill (in
 *  place, or not known: decided, or the approval would fail). */
export function isProjectCopy(draft: Draft): boolean {
  return (
    draft.operation === "update" &&
    draft.install_target !== null &&
    draft.install_base !== null &&
    draft.install_target !== draft.install_base
  );
}

/** Whether a pending update goes to the project's own copy of the skill:
 *  recorded for the project, and the core writes it over the folder it
 *  starts from, in the project. Installed "global" instead, the core would
 *  update only the global skill (or refuse without one) and leave the
 *  project's copy, which the project goes on using: the page offers no
 *  other place for it. An update the core can't place (both null) isn't
 *  one: nothing says the project has its own copy. */
export function updatesOwnCopy(draft: Draft): boolean {
  return (
    draft.operation === "update" &&
    draft.scope === "workspace" &&
    draft.install_target !== null &&
    draft.install_target === draft.install_base
  );
}

/** The largest file the core shows (its MAX_FILE_BYTES): a larger one
 *  answers 413, so it is known before it is read. */
export const MAX_SHOWN_BYTES = 1_048_576;

/** A file's size as Files shows it: B, KB with one decimal, MB with two. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // MB before the rounded KB would read 1024.0.
  const kb = (bytes / 1024).toFixed(1);
  if (Number(kb) < 1024) return `${kb} KB`;
  // Rounded up, so a file over the limit never reads like the limit itself
  // (1.00 MB).
  return `${(Math.ceil((bytes / (1024 * 1024)) * 100) / 100).toFixed(2)} MB`;
}

/** What reading one of a draft's files through the core's file route
 *  said: shown (200), too large (413), not text (415), or no answer to go
 *  by (any other failure: a network error, a timeout, a 404, a 5xx). */
export type FileReadOutcome = "shown" | "too_large" | "not_text" | "unchecked";

/** A file of a draft the page can't show, so an approval would install it
 *  unseen. */
export interface UnshowableFile {
  path: string;
  size: number;
  reason: Exclude<FileReadOutcome, "shown">;
}

/** The files of a draft the page can't show, in their order: one listed
 *  over MAX_SHOWN_BYTES (never read), else what reading it said; a file
 *  without an answer couldn't be checked. */
export function unshowableFiles(
  files: readonly DraftFile[],
  reads: ReadonlyMap<string, FileReadOutcome>
): UnshowableFile[] {
  const out: UnshowableFile[] = [];
  for (const f of files) {
    const outcome: FileReadOutcome =
      f.size > MAX_SHOWN_BYTES ? "too_large" : reads.get(f.path) ?? "unchecked";
    if (outcome !== "shown") {
      out.push({ path: f.path, size: f.size, reason: outcome });
    }
  }
  return out;
}

/** Whether Undo can take a decision back: the core keeps no backup of an
 *  update, so an approved update stays. */
export function isRevertible(
  draft: Draft,
  action: "approve" | "reject"
): boolean {
  return action === "reject" || draft.operation === "create";
}

const AUTOSKILLS_REFUSAL_TEXT = {
  not_loopback:
    "This WebUI server listens on the network, not on this machine only, so it doesn't approve or reject drafts. Start it with EvoSci --ui webui, or with npm run dev:local.",
  host_not_loopback:
    "This page is open by a network address. Drafts are reviewed from a page open at 127.0.0.1 or localhost on the machine that runs EvoScientist.",
  other_backend:
    "The deployment URL is not the EvoScientist that runs next to this WebUI server, so drafts are reviewed on the machine that runs it.",
  unsupported: "This EvoScientist version cannot review drafts from the WebUI.",
} as const;

/** Why this page can't approve or reject drafts, or null when it can. */
export function autoSkillsReadOnlyReason(
  access: SettingsWriteAccess | undefined
): string | null {
  if (!access) return "Checking whether this page can review drafts…";
  if (access.writable) return null;
  const reason: string = access.reason;
  if (Object.hasOwn(AUTOSKILLS_REFUSAL_TEXT, reason)) {
    return AUTOSKILLS_REFUSAL_TEXT[
      reason as keyof typeof AUTOSKILLS_REFUSAL_TEXT
    ];
  }
  if (Object.hasOwn(RELAY_REFUSAL_TEXT, reason)) {
    return RELAY_REFUSAL_TEXT[reason as keyof typeof RELAY_REFUSAL_TEXT];
  }
  return "This page can't review drafts right now.";
}
