import { NextRequest, NextResponse } from "next/server";
import { join, resolve, sep } from "path";
import { promises as fs } from "fs";
import {
  SKILL_DIRS,
  recordUninstall,
  isValidSkillName,
  isInstalledExpert,
  declaresSkillType,
  readSkillFileIn,
} from "@/lib/server/skills";
import { ProjectRefusedError, projectDir } from "@/lib/server/projects";
import { isCrossOrigin } from "@/lib/server/workspace";

// SKILL_DIRS (the global ~/.evoscientist/skills tier + legacy ~/.config
// fallback) is the single source of truth, shared with the install route.
// With `?project=<handle>` the route also reads, or removes from, that
// project's own skills/ folder (the backend's workspace tier); the handle
// names a project this machine's backend serves, never a path.

interface SkillCard {
  /** Directory name — the install/uninstall identity (matches the catalog). */
  name: string;
  /** Frontmatter name for display; falls back to the directory name. */
  title: string;
  description: string;
  dir: string;
  /** True when the dir also ships an EXPERT.md — the skill can be dispatched
   *  as an expert, and so appears in the Experts view as well as here. */
  isExpert: boolean;
  /** False only when `metadata.type` explicitly omits `skill`. */
  isSkill: boolean;
}

// Minimal frontmatter parse — we only need name + description. Avoids pulling
// in a YAML dependency.
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const match = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = match[1];
  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m"));
    if (!m) return undefined;
    return m[1].replace(/^["']|["']$/g, "").trim();
  };
  return { name: get("name"), description: get("description") };
}

/** The skills in one tier folder, skipping names an earlier tier listed
 *  (`seen`). `within`: a folder the tier itself must resolve inside, for a
 *  tier that may be a link (a project's skills/). */
async function readTier(
  dir: string,
  seen: Set<string>,
  within?: string
): Promise<SkillCard[]> {
  const skills: SkillCard[] = [];
  let entries: string[] = [];
  let realRoot: string;
  try {
    realRoot = await fs.realpath(dir);
    if (within !== undefined && !realRoot.startsWith(within + sep)) {
      return skills; // a link out of that folder
    }
    entries = await fs.readdir(dir);
  } catch {
    return skills; // dir doesn't exist
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const skillDir = join(dir, entry);
    try {
      // Canonicalize so a symlinked skill dir / SKILL.md can't read outside
      // the tier (consistent with getSkillDetail's guard): the folder here,
      // the file itself in readSkillFileIn.
      const realDir = await fs.realpath(skillDir);
      if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
        continue;
      }
      const stat = await fs.stat(realDir);
      if (!stat.isDirectory()) continue;
      const md = await readSkillFileIn(dir, entry, "SKILL.md");
      if (md === null) continue;
      const { name, description } = parseFrontmatter(md);
      // Identity is the DIRECTORY name (what install/uninstall/dedup key on);
      // the frontmatter name is display-only.
      if (seen.has(entry)) continue;
      seen.add(entry);
      skills.push({
        name: entry,
        title: name || entry,
        description: description || "",
        dir: skillDir,
        isExpert: await isInstalledExpert(realDir),
        isSkill: declaresSkillType(md),
      });
    } catch {
      // no SKILL.md or unreadable — skip
    }
  }
  return skills;
}

const byName = (a: SkillCard, b: SkillCard) => a.name.localeCompare(b.name);

async function readSkills(): Promise<SkillCard[]> {
  const skills: SkillCard[] = [];
  const seen = new Set<string>();
  for (const dir of SKILL_DIRS) skills.push(...(await readTier(dir, seen)));
  return skills.sort(byName);
}

/** The skills in the skills/ folder of the project `?project=` names; null
 *  without `?project=` or for a project this machine's backend doesn't
 *  serve. A skills/ that links out of the project lists none. */
async function readProjectSkills(
  request: NextRequest
): Promise<SkillCard[] | null> {
  if (!request.nextUrl.searchParams.has("project")) return null;
  const root = await projectDir(request).catch(() => null);
  if (root === null) return null;
  const skills = await readTier(join(root, "skills"), new Set(), root);
  return skills.sort(byName);
}

// Its own page only, like the workspace and memory routes: a page that
// rebound its name to this machine could list and remove the skills.
export async function GET(request: NextRequest) {
  if (isCrossOrigin(request)) {
    return NextResponse.json(
      { error: "Cross-origin access not allowed." },
      { status: 403 }
    );
  }
  try {
    // At once: the project's read asks the backend's registry, which can
    // take its timeout.
    const [skills, projectSkills] = await Promise.all([
      readSkills(),
      readProjectSkills(request),
    ]);
    return NextResponse.json({ skills, projectSkills });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read skills" },
      { status: 500 }
    );
  }
}

// Uninstall = remove the skill directory. Guard against path traversal and
// only delete inside the known skill dirs.
export async function DELETE(req: NextRequest) {
  if (isCrossOrigin(req)) {
    return NextResponse.json(
      { error: "Cross-origin access not allowed." },
      { status: 403 }
    );
  }
  const name = req.nextUrl.searchParams.get("name");
  // Strict name check (blocks dotfiles like `.installed.yaml`, traversal, odd
  // chars) — must match install-side validation, not the old slash/`..`-only one.
  if (!name || !isValidSkillName(name)) {
    return NextResponse.json({ error: "Invalid skill name" }, { status: 400 });
  }
  // Any `project` parameter, an empty one too, means that project's folder
  // alone: never a fallback to the global tiers.
  if (req.nextUrl.searchParams.has("project")) {
    return uninstallFromProject(req, name);
  }
  for (const dir of SKILL_DIRS) {
    const target = resolve(join(dir, name));
    if (target !== resolve(dir) && !target.startsWith(resolve(dir) + sep)) {
      continue;
    }
    try {
      // Only ever remove an actual skill directory, never a stray file.
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) continue;
    } catch {
      continue; // not here
    }
    await fs.rm(target, { recursive: true, force: true });
    // Keep EvoScientist's manifest in sync — drop the entry so onboard/CLI no
    // longer list it. Best-effort: don't fail the uninstall on a manifest error.
    await recordUninstall(name).catch(() => {});
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Skill not found" }, { status: 404 });
}

const skillNotFound = () =>
  NextResponse.json({ error: "Skill not found" }, { status: 404 });

/** Remove `<project>/skills/<name>`. The project's own tier only: neither the
 *  global tiers nor their manifest (.installed.yaml lists the global tier's
 *  skills, so recordUninstall stays out of it). A folder goes only when it
 *  holds a SKILL.md; a link of that name is unlinked whatever it points at. */
async function uninstallFromProject(req: NextRequest, name: string) {
  try {
    const root = await projectDir(req);
    const tier = join(root, "skills");
    const target = resolve(join(tier, name));
    if (!target.startsWith(tier + sep)) return skillNotFound();
    // skills/ may be a link within the project, never out of it (the
    // listing shows none of those).
    const realTier = await fs.realpath(tier).catch(() => null);
    if (realTier === null || !realTier.startsWith(root + sep)) {
      return skillNotFound();
    }
    const entry = join(realTier, name);
    const stat = await fs.lstat(entry).catch(() => null);
    if (stat?.isSymbolicLink()) {
      // A linked skill folder: the link goes, never what it points at.
      await fs.rm(entry, { force: true });
    } else if (stat?.isDirectory()) {
      const real = await fs.realpath(entry);
      if (!real.startsWith(realTier + sep)) return skillNotFound();
      // Only what the listing shows as a skill: a folder whose SKILL.md is
      // read inside the tier. The project is the user's own repo, and any
      // other folder under skills/ (skills/data/) is theirs to keep.
      if ((await readSkillFileIn(realTier, name, "SKILL.md")) === null) {
        return skillNotFound();
      }
      await fs.rm(real, { recursive: true, force: true });
    } else {
      return skillNotFound();
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to uninstall",
      },
      { status: error instanceof ProjectRefusedError ? 403 : 500 }
    );
  }
}
