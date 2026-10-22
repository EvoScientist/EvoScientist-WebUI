import { spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answers, loopbackJson, LoopbackError } from "./loopback";

let server: http.Server;
let base: string;
const seen: { method?: string; origin?: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, origin: req.headers.origin, body });
      if (req.url === "/slow") return; // never answers
      if (req.url === "/text") return res.end("hello");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("loopbackJson", () => {
  it("posts JSON without an Origin header", async () => {
    const r = await loopbackJson(`${base}/threads/search`, {
      method: "POST",
      body: { status: "busy" },
      timeoutMs: 2000,
    });
    expect(r).toEqual({ status: 200, body: { url: "/threads/search" } });
    expect(seen.at(-1)).toEqual({
      method: "POST",
      origin: undefined,
      body: '{"status":"busy"}',
    });
  });

  it("times out", async () => {
    await expect(
      loopbackJson(`${base}/slow`, { timeoutMs: 100 })
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses non-JSON and non-loopback URLs", async () => {
    await expect(
      loopbackJson(`${base}/text`, { timeoutMs: 2000 })
    ).rejects.toMatchObject({ kind: "bad_json" });
    await expect(
      loopbackJson("http://example.com/", { timeoutMs: 2000 })
    ).rejects.toBeInstanceOf(LoopbackError);
  });
});

describe("answers", () => {
  it("gives the status, or null when nothing listens", async () => {
    expect(await answers(`${base}/`, 2000)).toBe(200);
    expect(await answers("http://127.0.0.1:9/", 2000)).toBeNull();
  });
});

// The premise of this module: with NODE_USE_ENV_PROXY=1 and a proxy set,
// Node's global agent goes through the proxy, a fresh http.Agent does not.
const [major, minor] = process.versions.node.split(".").map(Number);
describe.skipIf(major < 24 || (major === 24 && minor < 5))(
  "NODE_USE_ENV_PROXY",
  () => {
    it("does not reach a fresh agent", () => {
      const script = (agent: string) =>
        `require('http').get(${JSON.stringify(
          base + "/ok"
        )}, { agent: ${agent} }, (r) => { console.log(r.statusCode); r.resume(); }).on('error', (e) => console.log('error ' + e.code))`;
      const env = {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "",
      };
      const viaGlobal = spawnSync(
        process.execPath,
        ["-e", script("undefined")],
        { env, encoding: "utf8" }
      );
      const viaFresh = spawnSync(
        process.execPath,
        ["-e", script("new (require('http').Agent)()")],
        { env, encoding: "utf8" }
      );
      expect(viaGlobal.stdout.trim()).toMatch(/^error/);
      expect(viaFresh.stdout.trim()).toBe("200");
    });
  }
);
