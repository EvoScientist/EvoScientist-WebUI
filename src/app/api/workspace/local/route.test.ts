import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const workspace = vi.hoisted(() => ({ dir: null as string | null }));

vi.mock("@/lib/server/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/workspace")>()),
  getWorkspaceDir: async () => {
    if (!workspace.dir)
      throw new Error("No active EvoScientist workspace found.");
    return workspace.dir;
  },
}));

import { GET } from "./route";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ws-local-"))
  );
  await fs.mkdir(path.join(tmp, "projA"));
  await fs.mkdir(path.join(tmp, "projB"));
  workspace.dir = path.join(tmp, "projA");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function get(key: string | null) {
  const url = new URL("http://localhost:4716/api/workspace/local");
  if (key !== null) url.searchParams.set("key", key);
  return GET(new NextRequest(url, { headers: { host: "localhost:4716" } }));
}

describe("GET /api/workspace/local", () => {
  it("reports the same folder when the backend's key resolves to it", async () => {
    await fs.symlink(path.join(tmp, "projA"), path.join(tmp, "link"));

    const res = await get(path.join(tmp, "link").split(path.sep).join("/"));

    expect(await res.json()).toEqual({
      dir: path.join(tmp, "projA"),
      sameFolder: true,
    });
  });

  it("reports another folder", async () => {
    const res = await get(path.join(tmp, "projB"));
    expect((await res.json()).sameFolder).toBe(false);
  });

  it("reports a folder missing on this machine as another folder", async () => {
    const res = await get("/nowhere/on/this/machine");
    expect((await res.json()).sameFolder).toBe(false);
  });

  it("answers 404 without a local workspace", async () => {
    workspace.dir = null;
    const res = await get(path.join(tmp, "projA"));
    expect(res.status).toBe(404);
  });

  it("requires the backend's key", async () => {
    const res = await get(null);
    expect(res.status).toBe(400);
  });
});
