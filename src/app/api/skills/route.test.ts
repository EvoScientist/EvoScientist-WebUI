import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A skills folder of the test's own: the real ones are the user's.
const dirs = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@/lib/server/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/skills")>()),
  SKILL_DIRS: dirs.list,
  recordUninstall: vi.fn(async () => {}),
}));
// No user config: only loopback names and this machine's own addresses.
vi.mock("@/lib/server/coreConfig", () => ({
  readCoreConfig: vi.fn(() => ({ port: 6174, allowedOrigins: [] })),
}));
// The project's folder comes from the backend's registry; each test names it.
vi.mock("@/lib/server/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/projects")>()),
  projectDir: vi.fn(),
}));

import { DELETE, GET } from "./route";
import { recordUninstall } from "@/lib/server/skills";
import { ProjectRefusedError, projectDir } from "@/lib/server/projects";

const SAME_ORIGIN = { host: "localhost:4716", "sec-fetch-site": "same-origin" };
// A browser's DELETE carries its Origin, which must match the Host.
const SAME_ORIGIN_DELETE = { ...SAME_ORIGIN, origin: "http://localhost:4716" };
// A page that rebound its own name to this machine: same-origin to the
// browser, but its name in the Host.
const REBOUND = {
  host: "rebind.example:4716",
  origin: "http://rebind.example:4716",
  "sec-fetch-site": "same-origin",
};
const CROSS_SITE = {
  host: "localhost:4716",
  origin: "http://evil.example",
  "sec-fetch-site": "cross-site",
};

const request = (method: string, headers: Record<string, string>, query = "") =>
  new NextRequest(`http://localhost:4716/api/skills${query}`, {
    method,
    headers,
  });

const REFUSED =
  "This project isn't served here: it isn't registered with the local backend, or its folder is missing.";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-route-"));
  mkdirSync(join(root, "victim"));
  writeFileSync(
    join(root, "victim", "SKILL.md"),
    "---\nname: victim\ndescription: A skill to keep\n---\n"
  );
  dirs.list.splice(0, dirs.list.length, root);
  vi.mocked(projectDir).mockRejectedValue(new ProjectRefusedError(REFUSED));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(recordUninstall).mockClear();
  vi.mocked(projectDir).mockReset();
});

// Every Plane-2 route answers its own page only (#97 left these out): a
// rebinding page could list the installed skills and remove them.
describe("/api/skills from another origin", () => {
  it("lists nothing to a rebinding page or another site", async () => {
    expect((await GET(request("GET", REBOUND))).status).toBe(403);
    expect((await GET(request("GET", CROSS_SITE))).status).toBe(403);
  });

  it("removes nothing for a rebinding page or another site", async () => {
    for (const headers of [REBOUND, CROSS_SITE]) {
      const res = await DELETE(request("DELETE", headers, "?name=victim"));
      expect(res.status).toBe(403);
    }
    expect(existsSync(join(root, "victim"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });
});

describe("/api/skills from its own page", () => {
  it("lists the installed skills", async () => {
    const res = await GET(request("GET", SAME_ORIGIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name)).toEqual(["victim"]);
  });

  it("uninstalls a skill", async () => {
    const res = await DELETE(
      request("DELETE", SAME_ORIGIN_DELETE, "?name=victim")
    );
    expect(res.status).toBe(200);
    expect(existsSync(join(root, "victim"))).toBe(false);
    expect(recordUninstall).toHaveBeenCalledWith("victim");
  });
});

// A project's own skills/ folder, named by its handle in `?project=` (the
// route never takes a path). The registry decides which folder that is.
describe("/api/skills for a project", () => {
  const HANDLE = "0f6b2a4e-6f1d-5c3a-9e8b-1a2b3c4d5e6f";
  // projectDir answers the folder canonical (realpath), as the real one does.
  let project: string;
  let outside: string;
  const skill = (dir: string, name: string, description = "") => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n`
    );
  };
  const listProject = async (query = `?project=${HANDLE}`) => {
    const res = await GET(request("GET", SAME_ORIGIN, query));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      skills: Array<{ name: string }>;
      projectSkills: Array<Record<string, unknown>> | null;
    };
  };
  const uninstall = (name: string, query = `?project=${HANDLE}`) =>
    DELETE(request("DELETE", SAME_ORIGIN_DELETE, `${query}&name=${name}`));

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "skills-project-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "skills-outside-")));
    vi.mocked(projectDir).mockResolvedValue(project);
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("lists the project's skills with ?project=", async () => {
    skill(join(project, "skills"), "drafted-skill", "Found in memory");
    skill(join(project, "skills"), "another-skill");
    const body = await listProject();
    // The global tier's list is the same as without a project.
    expect(body.skills.map((s) => s.name)).toEqual(["victim"]);
    expect(body.projectSkills?.map((s) => s.name)).toEqual([
      "another-skill",
      "drafted-skill",
    ]);
    expect(body.projectSkills?.[1]).toMatchObject({
      name: "drafted-skill",
      title: "drafted-skill",
      description: "Found in memory",
      isExpert: false,
      isSkill: true,
    });
  });

  it("lists none for a project without a skills folder", async () => {
    expect((await listProject()).projectSkills).toEqual([]);
  });

  it("projectSkills is null for a project not served", async () => {
    vi.mocked(projectDir).mockRejectedValue(new ProjectRefusedError(REFUSED));
    const body = await listProject();
    expect(body.projectSkills).toBeNull();
    expect(body.skills.map((s) => s.name)).toEqual(["victim"]);
  });

  it("projectSkills is null without ?project=", async () => {
    skill(join(project, "skills"), "drafted-skill");
    const body = await listProject("");
    expect(body.projectSkills).toBeNull();
    expect(body.skills.map((s) => s.name)).toEqual(["victim"]);
    expect(projectDir).not.toHaveBeenCalled();
  });

  it("lists nothing from a skills folder that links out of the project", async () => {
    skill(outside, "elsewhere");
    symlinkSync(outside, join(project, "skills"), "dir");
    expect((await listProject()).projectSkills).toEqual([]);
  });

  it("follows a skills folder linked within the project", async () => {
    skill(join(project, "shared", "skills"), "shared-skill");
    symlinkSync(
      join(project, "shared", "skills"),
      join(project, "skills"),
      "dir"
    );
    expect((await listProject()).projectSkills?.map((s) => s.name)).toEqual([
      "shared-skill",
    ]);
  });

  it("leaves out a skill folder that links out of the project's skills", async () => {
    skill(join(project, "skills"), "own-skill");
    skill(outside, "linked-out");
    symlinkSync(
      join(outside, "linked-out"),
      join(project, "skills", "linked-out"),
      "dir"
    );
    expect((await listProject()).projectSkills?.map((s) => s.name)).toEqual([
      "own-skill",
    ]);
  });

  // A SKILL.md is read only from inside its tier: one linked out of it
  // would put another file's name and description into the list.
  it("leaves out a project skill whose SKILL.md links out of the project", async () => {
    skill(join(project, "skills"), "own-skill");
    writeFileSync(
      join(outside, "SECRET.md"),
      "---\nname: secret-name\ndescription: secret-text\n---\n"
    );
    mkdirSync(join(project, "skills", "linked-file"), { recursive: true });
    symlinkSync(
      join(outside, "SECRET.md"),
      join(project, "skills", "linked-file", "SKILL.md")
    );
    const body = await listProject();
    expect(body.projectSkills?.map((s) => s.name)).toEqual(["own-skill"]);
    expect(JSON.stringify(body)).not.toContain("secret-");
  });

  it("leaves out a global skill whose SKILL.md links out of its tier", async () => {
    writeFileSync(
      join(outside, "SECRET.md"),
      "---\nname: secret-name\ndescription: secret-text\n---\n"
    );
    mkdirSync(join(root, "linked-file"));
    symlinkSync(
      join(outside, "SECRET.md"),
      join(root, "linked-file", "SKILL.md")
    );
    const body = await listProject("");
    expect(body.skills.map((s) => s.name)).toEqual(["victim"]);
    expect(JSON.stringify(body)).not.toContain("secret-");
  });

  it("reads the global tiers and the project at once", async () => {
    // The global tier's listing is held: the project's folder is still
    // asked for meanwhile (the registry can take its timeout).
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readdir = fsPromises.readdir.bind(fsPromises);
    const spy = vi.spyOn(fsPromises, "readdir").mockImplementation((async (
      path: unknown,
      ...rest: unknown[]
    ) => {
      if (path === root) await gate;
      return (readdir as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest
      );
    }) as never);
    try {
      const answer = GET(request("GET", SAME_ORIGIN, `?project=${HANDLE}`));
      await vi.waitFor(() => expect(projectDir).toHaveBeenCalled());
      release();
      const res = await answer;
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { skills: Array<{ name: string }> }).skills.map(
          (s) => s.name
        )
      ).toEqual(["victim"]);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("uninstalls from the project tier only", async () => {
    // The same name in the global tier stays, and so does the manifest:
    // .installed.yaml lists the global tier's skills.
    skill(join(project, "skills"), "victim");
    const res = await uninstall("victim");
    expect(res.status).toBe(200);
    expect(existsSync(join(project, "skills", "victim"))).toBe(false);
    expect(existsSync(join(root, "victim", "SKILL.md"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });

  it("removes a linked skill folder as a link and keeps what it points at", async () => {
    skill(outside, "linked");
    mkdirSync(join(project, "skills"));
    symlinkSync(
      join(outside, "linked"),
      join(project, "skills", "linked"),
      "dir"
    );
    const res = await uninstall("linked");
    expect(res.status).toBe(200);
    expect(readdirSync(join(project, "skills"))).toEqual([]);
    expect(existsSync(join(outside, "linked", "SKILL.md"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });

  it("removes nothing for a project not served", async () => {
    vi.mocked(projectDir).mockRejectedValue(new ProjectRefusedError(REFUSED));
    skill(join(project, "skills"), "victim");
    const res = await uninstall("victim");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: REFUSED });
    expect(existsSync(join(project, "skills", "victim"))).toBe(true);
    expect(existsSync(join(root, "victim"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });

  it("answers 404 for a skill the project doesn't have", async () => {
    // No skills folder at all, then one without that skill (a plain file of
    // the name doesn't count): the global copy is never the fallback.
    let res = await uninstall("victim");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Skill not found" });
    mkdirSync(join(project, "skills"));
    writeFileSync(join(project, "skills", "victim"), "not a skill folder");
    res = await uninstall("victim");
    expect(res.status).toBe(404);
    expect(existsSync(join(project, "skills", "victim"))).toBe(true);
    expect(existsSync(join(root, "victim"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });

  it("never removes through a skills folder that links out of the project", async () => {
    // Here it links to the global tier: its victim must stay.
    symlinkSync(root, join(project, "skills"), "dir");
    const res = await uninstall("victim");
    expect(res.status).toBe(404);
    expect(existsSync(join(root, "victim", "SKILL.md"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });

  it("an empty ?project= never falls back to the global tier", async () => {
    vi.mocked(projectDir).mockRejectedValue(new ProjectRefusedError(REFUSED));
    const res = await uninstall("victim", "?project=");
    expect(res.status).toBe(403);
    expect(existsSync(join(root, "victim"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });

  it("checks the name before asking for the project", async () => {
    const res = await uninstall("..%2Fvictim");
    expect(res.status).toBe(400);
    expect(projectDir).not.toHaveBeenCalled();
  });

  it("removes nothing in a project for another site", async () => {
    skill(join(project, "skills"), "victim");
    const res = await DELETE(
      request("DELETE", CROSS_SITE, `?project=${HANDLE}&name=victim`)
    );
    expect(res.status).toBe(403);
    expect(existsSync(join(project, "skills", "victim"))).toBe(true);
    expect(projectDir).not.toHaveBeenCalled();
  });
});
