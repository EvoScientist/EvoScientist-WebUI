// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseProjects,
  pickProject,
  readLastUsedProject,
  registeredTasks,
  samePath,
  withAppFolders,
  writeLastUsedProject,
} from "./projects";
import { readyProjects } from "@/test/mockProjects";
import { workspaceAssistantId } from "@/lib/workspaceAssistant";

beforeEach(() => localStorage.clear());

describe("parseProjects", () => {
  it("sorts by name, then path, and drops rows without a folder", () => {
    expect(
      parseProjects({
        workspaces: [
          { workspace_dir: "/srv/b/notes", name: "notes", missing: true },
          { workspace_dir: "/home/a/notes", name: "notes" },
          { workspace_dir: "/x/alpha", name: "alpha" },
          { name: "no folder" },
        ],
      })
    ).toEqual([
      { key: "/x/alpha", name: "alpha", missing: false },
      { key: "/home/a/notes", name: "notes", missing: false },
      { key: "/srv/b/notes", name: "notes", missing: true },
    ]);
  });

  it("refuses a body that isn't a project list", () => {
    expect(() => parseProjects({ detail: "Not Found" })).toThrow();
  });
});

describe("pickProject", () => {
  const state = readyProjects(
    "/a/alpha",
    { key: "/b/beta", name: "beta", missing: true },
    "/c/gamma"
  );

  it("takes the first preferred project that can run", () => {
    expect(pickProject(state, [null, "/b/beta", "/c/gamma"])?.key).toBe(
      "/c/gamma"
    );
  });

  it("falls back to the first by name, skipping missing folders", () => {
    expect(pickProject(state, ["/gone"])?.key).toBe("/a/alpha");
    expect(
      pickProject(
        readyProjects({ key: "/b/beta", name: "beta", missing: true }),
        []
      )
    ).toBeNull();
  });

  it("picks nothing until the projects are known", () => {
    expect(pickProject({ status: "pending" }, ["/a/alpha"])).toBeNull();
  });
});

describe("last used project", () => {
  it("is kept per deployment URL", () => {
    writeLastUsedProject("http://127.0.0.1:6174", "/a/alpha");
    writeLastUsedProject("http://10.0.0.2:6174", "/c/gamma");

    expect(readLastUsedProject("http://127.0.0.1:6174")).toBe("/a/alpha");
    expect(readLastUsedProject("http://10.0.0.2:6174")).toBe("/c/gamma");
    expect(readLastUsedProject("http://other:1")).toBeNull();
  });

  it("survives a damaged entry", () => {
    localStorage.setItem("evoscientist-last-project", "{not json");
    expect(readLastUsedProject("http://127.0.0.1:6174")).toBeNull();
    writeLastUsedProject("http://127.0.0.1:6174", "/a/alpha");
    expect(readLastUsedProject("http://127.0.0.1:6174")).toBe("/a/alpha");
  });
});

describe("registeredTasks", () => {
  it("keeps the tasks that run on a registered project's assistants", () => {
    const { projects } = readyProjects("/a/alpha", {
      key: "/b/beta",
      name: "beta",
      missing: true,
    });
    const task = (id: string, key: string) => ({
      id,
      assistantId: workspaceAssistantId("scheduler", key),
    });

    expect(
      registeredTasks(
        [task("1", "/a/alpha"), task("2", "/b/beta"), task("3", "/c/gone")],
        projects
      ).map((t) => t.id)
    ).toEqual(["1", "2"]);
  });
});

describe("samePath", () => {
  it("ignores case on Windows keys, the drive letter included", () => {
    expect(samePath("C:/Users/u/Proj", "c:/users/U/proj")).toBe(true);
    expect(samePath("C:/Users/u/Proj", "C:\\Users\\u\\Proj\\")).toBe(true);
    expect(samePath("C:/Users/u/Proj", "D:/Users/u/Proj")).toBe(false);
  });

  it("compares POSIX paths exactly", () => {
    expect(samePath("/home/u/Proj", "/home/u/proj")).toBe(false);
    expect(samePath("/home/u/proj", "/home/u/proj")).toBe(true);
  });

  it("tolerates a trailing slash", () => {
    expect(samePath("/home/u/proj", "/home/u/proj/")).toBe(true);
    expect(samePath("C:/", "C:")).toBe(true);
  });
});

describe("withAppFolders", () => {
  const projects = readyProjects(
    "/home/u/Documents/EvoScientist",
    "/home/u/alpha",
    "/srv/zeta"
  ).projects;

  it("names the default folder's project and sorts by that name", () => {
    const out = withAppFolders(projects, {
      default: "/home/u/Documents/EvoScientist",
    });
    expect(out.projects.map((p) => p.name)).toEqual([
      "alpha",
      "Default workspace",
      "zeta",
    ]);
    expect(out.projects[1].key).toBe("/home/u/Documents/EvoScientist");
    expect(out.launchKey).toBeNull();
  });

  it("gives the launch folder's key and keeps its folder name", () => {
    const out = withAppFolders(projects, {
      default: "/home/u/Documents/EvoScientist",
      launch: "/srv/zeta/",
    });
    expect(out.launchKey).toBe("/srv/zeta");
    expect(out.projects.find((p) => p.key === "/srv/zeta")?.name).toBe("zeta");
  });

  it("matches a Windows key whose drive letter is cased differently", () => {
    const out = withAppFolders(
      readyProjects("c:/Users/u/Documents/EvoScientist").projects,
      {
        default: "C:/Users/u/Documents/EvoScientist",
        launch: "C:/Users/u/Documents/EvoScientist",
      }
    );
    expect(out.projects[0].name).toBe("Default workspace");
    expect(out.launchKey).toBe("c:/Users/u/Documents/EvoScientist");
  });

  it("changes nothing for folders that are unknown or not projects", () => {
    for (const folders of [{}, { default: "/elsewhere", launch: "/gone" }]) {
      const out = withAppFolders(projects, folders);
      expect(out.projects).toEqual(projects);
      expect(out.launchKey).toBeNull();
    }
  });
});
