import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "net";
import { forwardSlowToBackend, type LocalBackend } from "./settingsRelay";

/** How the local backend answers. */
let respond: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let backend: LocalBackend;

beforeEach(async () => {
  respond = (_req, res) => res.end();
  server = createServer((req, res) => respond(req, res));
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const { port } = server.address() as AddressInfo;
  backend = {
    port,
    url: `http://127.0.0.1:${port}`,
    secretPath: "/nonexistent",
  };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("forwardSlowToBackend", () => {
  it("returns the backend's answer with its status and body", async () => {
    respond = (_req, res) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"done":true}');
    };

    const result = await forwardSlowToBackend(backend, "POST", "/x", {
      body: "{}",
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("content-type")).toBe(
      "application/json"
    );
    expect(await result.response.json()).toEqual({ done: true });
  });

  it.each([204, 304])(
    "returns an answer without a body for status %i",
    async (status) => {
      respond = (_req, res) => {
        res.writeHead(status);
        res.end();
      };

      const result = await forwardSlowToBackend(backend, "POST", "/x", {
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.status).toBe(status);
      expect(result.response.body).toBeNull();
    }
  );

  it("says the backend can't be reached when its answer is cut short", async () => {
    respond = (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "100",
      });
      res.write('{"partial":');
      setTimeout(() => res.socket?.destroy(), 20);
    };

    const result = await forwardSlowToBackend(backend, "POST", "/x", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ ok: false, refusal: "backend_unreachable" });
  });
});
