import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryFileExists, workspaceFileExists } from "./fileExistence";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("workspaceFileExists", () => {
  it("looks the file up in its folder's listing", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      json({ entries: [{ path: "out/a.md", type: "file" }] })
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await workspaceFileExists("out/a.md")).toBe(true);
    expect(await workspaceFileExists("out/b.md")).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/workspace?path=out");
  });

  it("treats a folder that can't be listed as gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "x" }, 400))
    );
    expect(await workspaceFileExists("gone/a.md")).toBe(false);
  });

  it("can't tell when the listing fails otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "x" }, 500))
    );
    expect(await workspaceFileExists("a.md")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    expect(await workspaceFileExists("a.md")).toBeNull();
  });
});

describe("memoryFileExists", () => {
  it("looks the file up in the memory listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ entries: [{ path: "notes/a.md" }], truncated: false })
      )
    );
    expect(await memoryFileExists("notes/a.md")).toBe(true);
    expect(await memoryFileExists("notes/b.md")).toBe(false);
  });

  it("can't tell from a truncated listing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ entries: [], truncated: true }))
    );
    expect(await memoryFileExists("notes/b.md")).toBeNull();
  });
});
