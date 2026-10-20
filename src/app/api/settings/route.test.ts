import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { PATCH } from "./route";
import { POST } from "./test-key/route";
import { GET as ACCESS } from "./access/route";
import { resetCoreConfigCache } from "@/lib/server/coreConfig";

const SECRET = "s3cr3t-value";
let dataDir: string;
const fetchMock = vi.fn();

function writeSecret(text = `${SECRET}\n`) {
  mkdirSync(join(dataDir, "server"), { recursive: true });
  writeFileSync(join(dataDir, "server", "local-secret"), text);
}

function request(
  path: string,
  {
    method = "PATCH",
    headers = {},
    body = '{"model":"gpt-5"}',
  }: { method?: string; headers?: Record<string, string>; body?: string } = {}
) {
  return new NextRequest(`http://127.0.0.1:4716${path}`, {
    method,
    headers: {
      host: "127.0.0.1:4716",
      origin: "http://127.0.0.1:4716",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: method === "GET" ? undefined : body,
  });
}

function backendAnswer(status: number, body: unknown = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "evo data ą-"));
  vi.stubEnv("EVOSCIENTIST_DATA_DIR", dataDir);
  vi.stubEnv("HOSTNAME", "127.0.0.1");
  // What dist/server.js and npm run dev:local set (scripts/bind-marker.mjs).
  vi.stubEnv("EVOSCIENTIST_WEBUI_BINDS_HOSTNAME", "1");
  vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "6606");
  resetCoreConfigCache();
  writeSecret();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("PATCH /api/settings", () => {
  it("adds the secret and forwards the body unchanged to the local backend", async () => {
    fetchMock.mockResolvedValue(backendAnswer(200, { revision: "r2" }));
    const res = await PATCH(request("/api/settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: "r2" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:6606/api/settings");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"model":"gpt-5"}');
    expect(init.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
  });

  it("takes the target from its own environment, never from the request", async () => {
    fetchMock.mockResolvedValue(backendAnswer(200));
    await PATCH(
      request("/api/settings", {
        headers: {
          "x-forwarded-host": "attacker.example",
          "x-forwarded-port": "80",
          forwarded: "host=attacker.example",
        },
      })
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6606/api/settings"
    );
  });

  it("uses the default port 6174 without the variable or a config.yaml port", async () => {
    vi.stubEnv("EVOSCIENTIST_LANGGRAPH_DEV_PORT", "");
    resetCoreConfigCache();
    fetchMock.mockResolvedValue(backendAnswer(200));
    await PATCH(request("/api/settings"));
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:6174/api/settings"
    );
  });

  it("returns the backend's errors unchanged", async () => {
    fetchMock.mockResolvedValue(
      backendAnswer(409, { error: "revision_mismatch", revision: "r9" })
    );
    const res = await PATCH(request("/api/settings"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "revision_mismatch",
      revision: "r9",
    });
  });

  it.each([undefined, "", "0.0.0.0", "my-machine", "4f2c1a9e0b7d"])(
    "refuses when HOSTNAME is %j (not bound to loopback)",
    async (hostname) => {
      if (hostname === undefined) delete process.env.HOSTNAME;
      else vi.stubEnv("HOSTNAME", hostname);
      const res = await PATCH(request("/api/settings"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "not_loopback" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("refuses a loopback HOSTNAME from a server that does not bind it (next dev, next start)", async () => {
    // `HOSTNAME=localhost npm run dev` listens on every interface; only the
    // standalone server and dev:local carry the marker.
    delete process.env.EVOSCIENTIST_WEBUI_BINDS_HOSTNAME;
    vi.stubEnv("HOSTNAME", "localhost");
    const res = await PATCH(request("/api/settings"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_loopback" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["::1", "localhost"])("accepts HOSTNAME=%s", async (hostname) => {
    vi.stubEnv("HOSTNAME", hostname);
    fetchMock.mockResolvedValue(backendAnswer(200));
    expect((await PATCH(request("/api/settings"))).status).toBe(200);
  });

  it("refuses a Host that is not a loopback name, such as the LAN address", async () => {
    const res = await PATCH(
      request("/api/settings", {
        headers: {
          host: "192.168.1.10:4716",
          origin: "http://192.168.1.10:4716",
        },
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host_not_loopback" });
    const named = await PATCH(
      request("/api/settings", {
        headers: {
          host: "attacker.example:4716",
          origin: "http://attacker.example:4716",
        },
      })
    );
    expect(await named.json()).toEqual({ error: "host_not_loopback" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ origin: "http://evil.example" }],
    [{ origin: "http://localhost:3000", "sec-fetch-site": "same-site" }],
    [{ "sec-fetch-site": "cross-site" }],
  ])("refuses a cross-origin request %j", async (headers) => {
    const res = await PATCH(request("/api/settings", { headers }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 415 without Content-Type: application/json", async () => {
    const res = await PATCH(
      request("/api/settings", { headers: { "content-type": "text/plain" } })
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "json_required" });
    fetchMock.mockResolvedValue(backendAnswer(200));
    const withCharset = await PATCH(
      request("/api/settings", {
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    );
    expect(withCharset.status).toBe(200);
  });

  it("says so clearly when the secret file is missing or empty", async () => {
    rmSync(join(dataDir, "server"), { recursive: true });
    const res = await PATCH(request("/api/settings"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "secret_missing" });
    writeSecret(" \n");
    expect(await (await PATCH(request("/api/settings"))).json()).toEqual({
      error: "secret_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the backend is down and 504 when it does not answer", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const down = await PATCH(request("/api/settings"));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: "backend_unreachable" });
    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError")
    );
    const slow = await PATCH(request("/api/settings"));
    expect(slow.status).toBe(504);
    expect(await slow.json()).toEqual({ error: "backend_timeout" });
  });
});

describe("POST /api/settings/test-key", () => {
  it("forwards to the backend's test-key with the secret", async () => {
    fetchMock.mockResolvedValue(
      backendAnswer(200, {
        ok: null,
        status: "inconclusive",
        message: "offline",
      })
    );
    const res = await POST(
      request("/api/settings/test-key", {
        method: "POST",
        body: '{"provider":"openai","key":"sk-x"}',
      })
    );
    expect(await res.json()).toEqual({
      ok: null,
      status: "inconclusive",
      message: "offline",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:6606/api/settings/test-key");
    expect(init.method).toBe("POST");
    expect(init.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
  });

  it("runs the same checks as PATCH", async () => {
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    const res = await POST(
      request("/api/settings/test-key", { method: "POST" })
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings/access", () => {
  const get = (headers: Record<string, string> = {}) =>
    ACCESS(request("/api/settings/access", { method: "GET", headers }));

  it("is writable when the backend accepts the secret, with its instance and revision", async () => {
    fetchMock
      .mockResolvedValueOnce(backendAnswer(204))
      .mockResolvedValueOnce(backendAnswer(200, { revision: "abc" }));
    const res = await get();
    expect(res.status).toBe(200);
    const expected = createHash("sha256")
      .update(`evoscientist-instance:${SECRET}`)
      .digest("hex")
      .slice(0, 16);
    expect(await res.json()).toEqual({
      writable: true,
      port: 6606,
      instance: expected,
      revision: "abc",
    });
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0];
    expect(verifyUrl).toBe("http://127.0.0.1:6606/api/local-secret/verify");
    expect(verifyInit.headers["X-EvoScientist-Local-Secret"]).toBe(SECRET);
    // The settings read needs no secret.
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
  });

  it.each([
    [403, "secret_rejected"],
    [404, "unsupported"],
    [500, "backend_unreachable"],
  ])("answers backend status %i as %s", async (status, reason) => {
    fetchMock.mockResolvedValueOnce(backendAnswer(status));
    expect(await (await get()).json()).toEqual({ writable: false, reason });
  });

  it("reports the relay's own refusals without calling the backend", async () => {
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    expect(await (await get()).json()).toEqual({
      writable: false,
      reason: "not_loopback",
    });
    vi.stubEnv("HOSTNAME", "127.0.0.1");
    expect(
      await (
        await get({
          host: "192.168.1.10:4716",
          origin: "http://192.168.1.10:4716",
        })
      ).json()
    ).toEqual({ writable: false, reason: "host_not_loopback" });
    rmSync(join(dataDir, "server"), { recursive: true });
    expect(await (await get()).json()).toEqual({
      writable: false,
      reason: "secret_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not need a JSON content type", async () => {
    fetchMock
      .mockResolvedValueOnce(backendAnswer(204))
      .mockResolvedValueOnce(backendAnswer(200, { revision: null }));
    const res = await get({ "content-type": "" });
    expect(await res.json()).toMatchObject({ writable: true, revision: null });
  });
});
