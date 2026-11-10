import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { resetCoreConfigCache } from "@/lib/server/coreConfig";

const SECRET = "s3cr3t-value";
let dataDir: string;
const fetchMock = vi.fn();

function request(
  body: unknown,
  { headers = {} }: { headers?: Record<string, string> } = {}
) {
  return new NextRequest("http://127.0.0.1:4716/api/autoskills", {
    method: "POST",
    headers: {
      host: "127.0.0.1:4716",
      origin: "http://127.0.0.1:4716",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "evo autoskills route ą-"));
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("/api/autoskills", () => {
  it("approves through the local backend with the secret", async () => {
    fetchMock.mockResolvedValue(answer(200, { approved: true }));

    const res = await POST(
      request({
        action: "approve",
        proposal_id: "arxiv-paper-retrieval",
        scope: "global",
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:6606/api/autoskills/proposals/arxiv-paper-retrieval/approve"
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      scope: "global",
      expected_updated_at: null,
    });
    expect(init.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
  });

  it.each([
    [{}, null],
    [{ scope: null }, null],
    [{ scope: "workspace" }, "workspace"],
  ])("approves with scope %j as %j", async (extra, scope) => {
    fetchMock.mockResolvedValue(answer(200, {}));

    await POST(request({ action: "approve", proposal_id: "a-b", ...extra }));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      scope,
      expected_updated_at: null,
    });
  });

  it.each([
    [{}, null],
    [{ expected_updated_at: null }, null],
    [
      { expected_updated_at: "2026-11-06T09:00:00.123456+00:00" },
      "2026-11-06T09:00:00.123456+00:00",
    ],
    [{ expected_updated_at: "x".repeat(64) }, "x".repeat(64)],
  ])(
    "approves with expected_updated_at %j forwarded as %j",
    async (extra, expected) => {
      fetchMock.mockResolvedValue(answer(200, {}));

      await POST(
        request({
          action: "approve",
          proposal_id: "a-b",
          scope: "global",
          ...extra,
        })
      );

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        scope: "global",
        expected_updated_at: expected,
      });
    }
  );

  // Reject carries the version too (the core answers 409 draft_changed for
  // a draft rewritten since), never a scope; revert takes no body.
  it.each([
    [{}, null],
    [{ expected_updated_at: null }, null],
    [
      { expected_updated_at: "2026-11-06T09:00:00.123Z" },
      "2026-11-06T09:00:00.123Z",
    ],
    [{ expected_updated_at: "x".repeat(64) }, "x".repeat(64)],
    [
      { expected_updated_at: "2026-11-06T09:00:00Z", scope: "global" },
      "2026-11-06T09:00:00Z",
    ],
  ])(
    "rejects with expected_updated_at %j forwarded as %j, and no scope",
    async (extra, expected) => {
      fetchMock.mockResolvedValue(answer(200, {}));

      await POST(request({ action: "reject", proposal_id: "a-b", ...extra }));

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        expected_updated_at: expected,
      });
    }
  );

  it("a revert sends no expected_updated_at", async () => {
    fetchMock.mockImplementation(async () => answer(200, {}));

    await POST(
      request({
        action: "revert",
        proposal_id: "a-b",
        expected_updated_at: "2026-11-06T09:00:00+00:00",
      })
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
  });

  it("rejects, reverts and runs on their core paths", async () => {
    fetchMock.mockImplementation(async () => answer(200, {}));

    await POST(request({ action: "reject", proposal_id: "a-b" }));
    await POST(request({ action: "revert", proposal_id: "a-b" }));
    await POST(request({ action: "run", workspace_dir: "/home/you/my proj" }));

    const calls = fetchMock.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:6606/api/autoskills/proposals/a-b/reject",
      "http://127.0.0.1:6606/api/autoskills/proposals/a-b/revert",
      "http://127.0.0.1:6606/api/autoskills/run",
    ]);
    expect(calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { expected_updated_at: null },
      {},
      { workspace_dir: "/home/you/my proj" },
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(init.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
    }
  });

  it("refuses an id that isn't a skill name", async () => {
    for (const id of ["../x", "a/b", "", 5, null]) {
      const res = await POST(request({ action: "reject", proposal_id: id }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown action", { action: "delete", proposal_id: "a-b" }],
    ["a missing action", { proposal_id: "a-b" }],
    ["a bad scope", { action: "approve", proposal_id: "a-b", scope: "all" }],
    ["a numeric scope", { action: "approve", proposal_id: "a-b", scope: 1 }],
    [
      "a numeric expected_updated_at",
      { action: "approve", proposal_id: "a-b", expected_updated_at: 1 },
    ],
    [
      "an expected_updated_at that is an object",
      { action: "approve", proposal_id: "a-b", expected_updated_at: {} },
    ],
    [
      "an expected_updated_at over 64 characters",
      {
        action: "approve",
        proposal_id: "a-b",
        expected_updated_at: "x".repeat(65),
      },
    ],
    [
      "an expected_updated_at with a control character",
      {
        action: "approve",
        proposal_id: "a-b",
        expected_updated_at: "2026-11-06\n",
      },
    ],
    [
      "a reject with a numeric expected_updated_at",
      { action: "reject", proposal_id: "a-b", expected_updated_at: 1 },
    ],
    [
      "a reject with an expected_updated_at that is an object",
      { action: "reject", proposal_id: "a-b", expected_updated_at: {} },
    ],
    [
      "a reject with an expected_updated_at over 64 characters",
      {
        action: "reject",
        proposal_id: "a-b",
        expected_updated_at: "x".repeat(65),
      },
    ],
    [
      "a reject with a control character in expected_updated_at",
      {
        action: "reject",
        proposal_id: "a-b",
        expected_updated_at: "2026-11-06\n",
      },
    ],
    ["a run without a folder", { action: "run" }],
    ["a run with a blank folder", { action: "run", workspace_dir: "  " }],
    [
      "a run with a control character",
      { action: "run", workspace_dir: "/a\nb" },
    ],
    ["a body that isn't an object", []],
  ])("refuses %s without asking the backend", async (_label, body) => {
    const res = await POST(request(body));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the core's 409 through", async () => {
    fetchMock.mockResolvedValue(
      answer(409, { error: "not_pending", status: "approved" })
    );

    const res = await POST(request({ action: "reject", proposal_id: "a-b" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "not_pending",
      status: "approved",
    });
  });

  it("refuses a cross-origin page", async () => {
    const res = await POST(
      request(
        { action: "reject", proposal_id: "a-b" },
        {
          headers: {
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
          },
        }
      )
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the server isn't bound to loopback", async () => {
    vi.stubEnv("EVOSCIENTIST_WEBUI_BINDS_HOSTNAME", "");

    const res = await POST(request({ action: "reject", proposal_id: "a-b" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_loopback" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when it can't read the local secret", async () => {
    rmSync(join(dataDir, "server", "local-secret"));

    const res = await POST(request({ action: "reject", proposal_id: "a-b" }));

    expect(await res.json()).toEqual({ error: "secret_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
