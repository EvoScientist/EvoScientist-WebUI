import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { resetCoreConfigCache } from "@/lib/server/coreConfig";
import { resetMoveProbeCache } from "@/lib/server/projects";

const SECRET = "s3cr3t-value";
let dataDir: string;
let backend: Server;

interface Seen {
  method?: string;
  url?: string;
  secret?: string | string[];
  body: string;
}

/** What the local backend answers, and the requests it got. */
let respond: (seen: Seen) => { status: number; body: unknown } | null;
let seen: Seen[];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function request(
  method: "GET" | "POST",
  {
    headers = {},
    body = '{"old":"/home/you/old project","new":"/home/you/new project"}',
  }: { headers?: Record<string, string>; body?: string } = {}
) {
  return new NextRequest("http://127.0.0.1:4716/api/projects/move", {
    method,
    headers: {
      host: "127.0.0.1:4716",
      origin: "http://127.0.0.1:4716",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: method === "POST" ? body : undefined,
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "evo move route ą-"));
  mkdirSync(join(dataDir, "server"), { recursive: true });
  writeFileSync(join(dataDir, "server", "local-secret"), `${SECRET}\n`);
  seen = [];
  respond = () => ({ status: 404, body: { detail: "Not Found" } });
  backend = createServer(async (req, res) => {
    const entry: Seen = {
      method: req.method,
      url: req.url,
      secret: req.headers["x-evoscientist-local-secret"],
      body: await readBody(req),
    };
    seen.push(entry);
    const answer = respond(entry);
    // null: never answers.
    if (answer === null) return;
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) =>
    backend.listen(0, "127.0.0.1", () => resolve())
  );
  const { port } = backend.address() as AddressInfo;
  vi.stubEnv("EVOSCIENTIST_DATA_DIR", dataDir);
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  vi.stubEnv("EVOSCIENTIST_WEBUI_BINDS_HOSTNAME", "1");
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", String(port));
  resetCoreConfigCache();
  resetMoveProbeCache();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("POST /api/projects/move", () => {
  it("moves the project on the local backend with the secret", async () => {
    respond = () => ({
      status: 200,
      body: { workspace_dir: "/home/you/new project", threads: 2, moved: true },
    });

    const res = await POST(request("POST"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace_dir: "/home/you/new project",
      threads: 2,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/workspaces/move");
    expect(seen[0].secret).toBe(SECRET);
    expect(JSON.parse(seen[0].body)).toEqual({
      old: "/home/you/old project",
      new: "/home/you/new project",
    });
  });

  it("returns the backend's refusals unchanged", async () => {
    respond = () => ({
      status: 500,
      body: { error: "move_failed", detail: "disk full", pending: true },
    });

    const res = await POST(request("POST"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "move_failed",
      detail: "disk full",
      pending: true,
    });
  });

  it("waits up to 30 minutes for the move, then says it timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    respond = () => null;

    const pending = POST(request("POST"));
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    const res = await pending;
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "backend_timeout" });
  });

  it.each([
    ["no old folder", '{"new":"/x"}'],
    ["an empty new folder", '{"old":"/x","new":"  "}'],
    ["a folder with a control character", '{"old":"/a\\nb","new":"/x"}'],
    ["a body that isn't an object", "[]"],
  ])("refuses %s without asking the backend", async (_label, body) => {
    const res = await POST(request("POST", { body }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
    expect(seen).toHaveLength(0);
  });

  it("says the backend can't be reached when nothing listens on its port", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", () => resolve())
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", String(port));
    resetCoreConfigCache();

    const res = await POST(request("POST"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "backend_unreachable" });
  });

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
    expect(seen).toHaveLength(0);
  });
});

describe("GET /api/projects/move", () => {
  const secretRefusal = () => ({
    status: 403,
    body: { error: "local_secret_required" },
  });

  it("finds the move on a backend that refuses it without the secret", async () => {
    respond = secretRefusal;

    const res = await GET(request("GET"));

    expect(await res.json()).toEqual({ supported: true });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/workspaces/move");
    // Asked without the secret: the backend refuses before moving anything.
    expect(seen[0].secret).toBeUndefined();
  });

  it("finds no move on a backend that answers 404", async () => {
    const res = await GET(request("GET"));

    expect(await res.json()).toEqual({ supported: false });
  });

  it("asks the backend once per instance", async () => {
    respond = secretRefusal;

    await GET(request("GET"));
    const again = await GET(request("GET"));

    expect(await again.json()).toEqual({ supported: true });
    expect(seen).toHaveLength(1);
  });

  it("asks a backend without the move again after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    await GET(request("GET"));
    respond = secretRefusal;

    vi.setSystemTime(30_000);
    const soon = await GET(request("GET"));
    vi.setSystemTime(61_000);
    const later = await GET(request("GET"));

    expect(await soon.json()).toEqual({ supported: false });
    expect(await later.json()).toEqual({ supported: true });
    expect(seen).toHaveLength(2);
  });

  it("asks again for a backend with another local secret", async () => {
    respond = secretRefusal;
    await GET(request("GET"));
    writeFileSync(join(dataDir, "server", "local-secret"), "another\n");

    await GET(request("GET"));

    expect(seen).toHaveLength(2);
  });

  it("takes only the secret's refusal as the move", async () => {
    respond = () => ({ status: 403, body: { error: "origin_not_allowed" } });
    const other = await GET(request("GET"));
    respond = secretRefusal;

    const next = await GET(request("GET"));

    expect(await other.json()).toEqual({ supported: false });
    expect(await next.json()).toEqual({ supported: true });
  });

  it("does not keep an answer that is neither", async () => {
    respond = () => ({ status: 500, body: {} });
    const failed = await GET(request("GET"));
    respond = secretRefusal;

    const next = await GET(request("GET"));

    expect(await failed.json()).toEqual({ supported: false });
    expect(await next.json()).toEqual({ supported: true });
  });

  it("offers no move to a page the relay refuses", async () => {
    respond = secretRefusal;
    vi.stubEnv("HOSTNAME", "0.0.0.0");

    const res = await GET(request("GET"));

    expect(await res.json()).toEqual({ supported: false });
    expect(seen).toHaveLength(0);
  });
});
