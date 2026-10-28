import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { DELETE, POST } from "./route";
import { resetCoreConfigCache } from "@/lib/server/coreConfig";

const SECRET = "s3cr3t-value";
let dataDir: string;
const fetchMock = vi.fn();

function request(
  method: "POST" | "DELETE",
  {
    headers = {},
    body = '{"workspace_dir":"/home/you/my project"}',
  }: { headers?: Record<string, string>; body?: string } = {}
) {
  return new NextRequest("http://127.0.0.1:4716/api/projects", {
    method,
    headers: {
      host: "127.0.0.1:4716",
      origin: "http://127.0.0.1:4716",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "evo projects route ą-"));
  mkdirSync(join(dataDir, "server"), { recursive: true });
  writeFileSync(join(dataDir, "server", "local-secret"), `${SECRET}\n`);
  vi.stubEnv("EVOSCIENTIST_DATA_DIR", dataDir);
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("EVOSCIENTIST_WEBUI_BINDS_HOSTNAME", "1");
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "6606");
  resetCoreConfigCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("/api/projects", () => {
  it("adds a project on the local backend with the secret", async () => {
    fetchMock.mockResolvedValue(
      answer(200, { workspace_dir: "/home/you/my project", host: "127.0.0.1" })
    );

    const res = await POST(request("POST"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace_dir: "/home/you/my project",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:6606/api/workspaces");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      workspace_dir: "/home/you/my project",
    });
    expect(init.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
  });

  it("removes a project with the folder in the query, and no body", async () => {
    fetchMock.mockResolvedValue(answer(200, { workspace_dir: "/x" }));

    await DELETE(request("DELETE"));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:6606/api/workspaces?workspace_dir=%2Fhome%2Fyou%2Fmy+project"
    );
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(init.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
  });

  it("returns the backend's refusals unchanged", async () => {
    fetchMock.mockResolvedValue(
      answer(409, { error: "enabled_user_crons", cron_ids: ["c1"] })
    );

    const res = await DELETE(request("DELETE"));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "enabled_user_crons",
      cron_ids: ["c1"],
    });
  });

  it.each([undefined, "0.0.0.0"])(
    "refuses when HOSTNAME is %j (not bound to loopback)",
    async (hostname) => {
      if (hostname === undefined) delete process.env.HOSTNAME;
      else vi.stubEnv("HOSTNAME", hostname);

      const res = await POST(request("POST"));

      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("refuses another site's page", async () => {
    const res = await POST(
      request("POST", {
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      })
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    const res = await POST(
      request("POST", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "workspace_dir=/x",
      })
    );

    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no folder", "{}"],
    ["an empty folder", '{"workspace_dir":"  "}'],
    ["a folder with a control character", '{"workspace_dir":"/a\\nb"}'],
    ["a body that isn't an object", "[]"],
  ])("refuses %s without asking the backend", async (_label, body) => {
    const res = await POST(request("POST", { body }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when it can't read the local secret", async () => {
    rmSync(join(dataDir, "server", "local-secret"));

    const res = await POST(request("POST"));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "secret_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the folder as named, spaces and all", async () => {
    fetchMock.mockResolvedValue(answer(200, { workspace_dir: "/data/proj " }));

    await DELETE(
      request("DELETE", { body: '{"workspace_dir":"/data/proj "}' })
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6606/api/workspaces?workspace_dir=%2Fdata%2Fproj+"
    );
  });
});
