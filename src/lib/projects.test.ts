// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseProjects,
  pickProject,
  readLastUsedProject,
  writeLastUsedProject,
} from "./projects";
import { readyProjects } from "@/test/mockProjects";

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
