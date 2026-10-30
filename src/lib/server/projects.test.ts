import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import {
  localProjects,
  projectDir,
  resetProjectRegistryCache,
} from "./projects";
import { projectHandle } from "@/lib/projects";
import { resetCoreConfigCache } from "@/lib/server/coreConfig";
import { GET as LIST } from "@/app/api/workspace/route";
import {
  DELETE as REMOVE_FILE,
  GET as READ_FILE,
  PUT as WRITE_FILE,
} from "@/app/api/workspace/file/route";
import { POST as UPLOAD } from "@/app/api/workspace/upload/route";
import { GET as DOWNLOAD } from "@/app/api/workspace/download/route";

let root: string;
let projA: string;
const fetchMock = vi.fn();

function registry(
  rows: Array<{ workspace_dir: string; missing?: boolean }>,
  status = 200
) {
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          workspaces: rows.map((row) => ({
            name: row.workspace_dir.split("/").at(-1),
            missing: false,
            ...row,
          })),
        }),
        { status, headers: { "content-type": "application/json" } }
      )
  );
}

function request(project: string | null, path = "/api/workspace") {
  const query = project === null ? "" : `?${new URLSearchParams({ project })}`;
  return new NextRequest(`http://127.0.0.1:4716${path}${query}`, {
    headers: { host: "127.0.0.1:4716", "sec-fetch-site": "same-origin" },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evo projects ą-"));
  projA = join(root, "projA");
  mkdirSync(projA);
  writeFileSync(join(projA, "notes.md"), "hi");
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "6606");
  resetCoreConfigCache();
  resetProjectRegistryCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("projectDir", () => {
  it("finds a registered project's folder by its handle", async () => {
    registry([{ workspace_dir: projA }]);

    await expect(projectDir(request(projectHandle(projA)))).resolves.toBe(
      realpathSync(projA)
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:6606/api/workspaces",
      expect.objectContaining({ method: "GET" })
    );
  });

  it.each([
    ["no handle", null],
    ["a handle that isn't a UUID", "../projA"],
    ["an unknown handle", projectHandle("/somewhere/else")],
  ])("refuses %s", async (_label, project) => {
    registry([{ workspace_dir: projA }]);

    await expect(projectDir(request(project))).rejects.toThrow(
      /isn't served here/
    );
  });

  it("refuses a project whose folder is missing", async () => {
    registry([{ workspace_dir: projA, missing: true }]);

    await expect(projectDir(request(projectHandle(projA)))).rejects.toThrow(
      /isn't served here/
    );
  });

  it("refuses a project whose folder went away since the backend looked", async () => {
    const gone = join(root, "gone");
    registry([{ workspace_dir: gone }]);

    await expect(projectDir(request(projectHandle(gone)))).rejects.toThrow(
      /isn't served here/
    );
  });

  it("refuses everything when the local backend can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(projectDir(request(projectHandle(projA)))).rejects.toThrow(
      /can't be reached/
    );
  });

  it("reads the registry at most once a second", async () => {
    registry([{ workspace_dir: projA }]);

    await localProjects(1_000);
    await localProjects(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await localProjects(2_100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks again after a failed read", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(localProjects(1_000)).rejects.toThrow();
    registry([{ workspace_dir: projA }]);

    await expect(localProjects(1_100)).resolves.toHaveLength(1);
  });
});

describe("GET /api/workspace", () => {
  it("lists the named project's folder", async () => {
    registry([{ workspace_dir: projA }]);

    const res = await LIST(request(projectHandle(projA)));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ path: string }> };
    expect(body.entries.map((e) => e.path)).toEqual(["notes.md"]);
  });

  it("refuses a project this machine's backend doesn't serve", async () => {
    registry([]);

    const res = await LIST(request(projectHandle(projA)));

    // Not 400, which the file views read as a file that is gone.
    expect(res.status).toBe(403);
  });
});

describe("the file routes", () => {
  function call(
    method: string,
    path: string,
    query: Record<string, string> = {},
    body?: BodyInit
  ) {
    const params = new URLSearchParams({
      project: projectHandle(projA),
      ...query,
    });
    return new NextRequest(`http://127.0.0.1:4716${path}?${params}`, {
      method,
      body,
      headers: { host: "127.0.0.1:4716", "sec-fetch-site": "same-origin" },
    });
  }

  function files() {
    const form = new FormData();
    form.append("files", new File(["new"], "new.md"));
    return form;
  }

  const sends: Array<[string, () => Promise<Response>]> = [
    [
      "upload",
      () => UPLOAD(call("POST", "/api/workspace/upload", {}, files())),
    ],
    [
      "read a file",
      () => READ_FILE(call("GET", "/api/workspace/file", { path: "notes.md" })),
    ],
    [
      "write a file",
      () =>
        WRITE_FILE(
          call(
            "PUT",
            "/api/workspace/file",
            { path: "notes.md" },
            JSON.stringify({ content: "changed" })
          )
        ),
    ],
    [
      "delete a file",
      () =>
        REMOVE_FILE(
          call("DELETE", "/api/workspace/file", { path: "notes.md" })
        ),
    ],
    [
      "download the folder",
      () => DOWNLOAD(call("GET", "/api/workspace/download")),
    ],
  ];

  it.each(sends)(
    "refuse to %s in a project this machine's backend doesn't serve",
    async (_, send) => {
      registry([]);

      const res = await send();

      expect(res.status).toBe(403);
      expect(readdirSync(projA)).toEqual(["notes.md"]);
      expect(readFileSync(join(projA, "notes.md"), "utf8")).toBe("hi");
    }
  );

  it.each(sends)(
    "%s in a project this machine's backend serves",
    async (_, send) => {
      registry([{ workspace_dir: projA }]);

      const res = await send();

      expect(res.status).toBeLessThan(300);
    }
  );

  it("refuse an upload before reading its body", async () => {
    registry([]);
    const request = call("POST", "/api/workspace/upload", {}, files());

    const res = await UPLOAD(request);

    expect(res.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
  });
});
