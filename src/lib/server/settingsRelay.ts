// The WebUI's relay for the EvoScientist settings routes that need the local
// secret (PATCH /api/settings, POST /api/settings/test-key). The browser never
// holds the secret: these routes read it from the server home and add it only
// when this server listens on loopback (so only this machine reaches it) and
// the request names a loopback host from this WebUI's own page, and send it
// only toward the local backend.
//
// SECURITY: the target is built from this server's own environment and
// config.yaml (coreConfig.ts), never from the request's URL, Host or headers,
// so no page can make the relay send the secret elsewhere.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { request as httpRequest } from "http";
import { join } from "path";
import { NextResponse, type NextRequest } from "next/server";
import { isLoopbackHost } from "@/lib/backendBoundary";
import { readCoreConfig } from "@/lib/server/coreConfig";
import type { RelayRefusal } from "@/lib/settings";
import { globalDataDir } from "@/lib/server/paths";
import { hostHeaderName, isCrossOrigin } from "@/lib/server/workspace";

/** The header the backend reads the local secret from (C12). */
export const LOCAL_SECRET_HEADER = "X-EvoScientist-Local-Secret";

/** How long a forwarded request may take. A save checks every changed API key
 *  online first (10 s each at most in the backend), so allow for several. */
export const FORWARD_TIMEOUT_MS = 120_000;

// The values `HOSTNAME` takes when the packaged server listens on loopback
// only. Unset is not one of them: the standalone server then binds 0.0.0.0.
const LOOPBACK_BIND_NAMES = new Set(["127.0.0.1", "::1", "localhost"]);

const REFUSAL_STATUS: Record<RelayRefusal, number> = {
  not_loopback: 403,
  host_not_loopback: 403,
  cross_origin: 403,
  json_required: 415,
  secret_missing: 503,
  secret_rejected: 403,
  backend_unreachable: 502,
  backend_timeout: 504,
  unsupported: 404,
};

/** A refusal in the backend's error shape, `{"error": "<code>"}`. */
export function refusal(code: RelayRefusal): NextResponse {
  return NextResponse.json(
    { error: code },
    { status: REFUSAL_STATUS[code], headers: { "Cache-Control": "no-store" } }
  );
}

/** Set by the servers that listen exactly on `HOSTNAME`: the standalone
 *  `dist/server.js` (scripts/assemble-standalone.mjs writes it at its top)
 *  and `npm run dev:local` (scripts/bind-marker.mjs). */
export const BIND_MARKER = "EVOSCIENTIST_WEBUI_BINDS_HOSTNAME";

/** Whether this server listens on loopback only, as far as a route can tell:
 *  `HOSTNAME` is a loopback name and the server is one that binds it. Plain
 *  `next dev` and `next start` ignore `HOSTNAME` and listen on every
 *  interface, so a loopback `HOSTNAME` alone proves nothing there. */
export function boundToLoopback(env = process.env): boolean {
  const host = env.HOSTNAME?.trim().toLowerCase();
  return (
    env[BIND_MARKER] === "1" &&
    host !== undefined &&
    LOOPBACK_BIND_NAMES.has(host)
  );
}

/**
 * The checks every secret-bearing route runs, in order: this server listens on
 * loopback only, the request is addressed to a loopback name (not the LAN
 * address, not a DNS name), it comes from a page on this WebUI's own origin,
 * and, for routes with a body, the body is JSON (a cross-site form cannot send
 * that). Returns the first refusal, or null.
 */
export function relayGate(
  request: NextRequest,
  { requireJson }: { requireJson: boolean }
): RelayRefusal | null {
  if (!boundToLoopback()) return "not_loopback";
  const name = hostHeaderName(request.headers.get("host") ?? "");
  if (name === null || !isLoopbackHost(name)) return "host_not_loopback";
  if (isCrossOrigin(request)) return "cross_origin";
  if (requireJson) {
    const type = request.headers.get("content-type") ?? "";
    if (type.split(";")[0].trim().toLowerCase() !== "application/json") {
      return "json_required";
    }
  }
  return null;
}

/** Where the local backend is, from one reading of this server's
 *  configuration per request: the port a request sends to is the port it
 *  reports. */
export interface LocalBackend {
  /** The backend's port (see `readCoreConfig`). */
  port: number;
  /** Its base URL, on loopback. */
  url: string;
  /** The local secret file (C12): this server's own,
   *  `globalDataDir()/server/local-secret`. */
  secretPath: string;
}

/** The local backend, resolved once for a request. */
export function localBackend(): LocalBackend {
  const { port } = readCoreConfig();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    secretPath: join(globalDataDir(), "server", "local-secret"),
  };
}

/** The local secret as the backend reads it (`ensure_local_secret()` in
 *  local_secret.py: the bytes with ASCII whitespace stripped, ASCII only), or
 *  null when the file is missing, empty or unreadable. Read per request: the
 *  backend creates the file when it first starts, possibly after the WebUI. */
export function readLocalSecret(backend: LocalBackend): string | null {
  let raw: string;
  try {
    raw = readFileSync(backend.secretPath, "latin1");
  } catch {
    return null;
  }
  const value = raw.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
  // eslint-disable-next-line no-control-regex
  return value !== "" && /^[\x00-\x7f]+$/.test(value) ? value : null;
}

/** The backend's `instance` value for a secret: it identifies the running
 *  backend without revealing the secret (agreed on WebUI#55, point 4). */
export function instanceOf(secret: string): string {
  return createHash("sha256")
    .update(`evoscientist-instance:${secret}`, "ascii")
    .digest("hex")
    .slice(0, 16);
}

export type ForwardResult =
  | { ok: true; response: Response }
  | { ok: false; refusal: "backend_unreachable" | "backend_timeout" };

/** Send one request to `backend`, with the secret when given. */
export async function forwardToBackend(
  backend: LocalBackend,
  method: string,
  path: string,
  {
    secret,
    body,
    timeoutMs = FORWARD_TIMEOUT_MS,
  }: { secret?: string; body?: string; timeoutMs?: number } = {}
): Promise<ForwardResult> {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers[LOCAL_SECRET_HEADER] = secret;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(`${backend.url}${path}`, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, response };
  } catch (error) {
    const timedOut =
      error instanceof DOMException && error.name === "TimeoutError";
    return {
      ok: false,
      refusal: timedOut ? "backend_timeout" : "backend_unreachable",
    };
  }
}

/** As `forwardToBackend`, for a request that may take longer than `fetch`
 *  waits for an answer to start (5 min in Node). */
export function forwardSlowToBackend(
  backend: LocalBackend,
  method: string,
  path: string,
  {
    secret,
    body,
    timeoutMs,
  }: { secret?: string; body?: string; timeoutMs: number }
): Promise<ForwardResult> {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers[LOCAL_SECRET_HEADER] = secret;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ForwardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = httpRequest(
      `${backend.url}${path}`,
      { method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", () =>
          settle({ ok: false, refusal: "backend_unreachable" })
        );
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          const type = response.headers["content-type"];
          settle({
            ok: true,
            response: new Response(
              NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks),
              { status, headers: type ? { "Content-Type": type } : {} }
            ),
          });
        });
      }
    );
    const timer = setTimeout(() => {
      settle({ ok: false, refusal: "backend_timeout" });
      request.destroy();
    }, timeoutMs);
    request.on("error", () =>
      settle({ ok: false, refusal: "backend_unreachable" })
    );
    request.end(body);
  });
}

/** Statuses a `Response` can't carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** The backend's answer, status and body unchanged. */
export async function passThrough(response: Response): Promise<NextResponse> {
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** PATCH /api/settings and POST /api/settings/test-key: gate, add the secret,
 *  forward the JSON body as it came, return the backend's answer. */
export async function relayWrite(
  request: NextRequest,
  method: "PATCH" | "POST",
  path: string
): Promise<NextResponse> {
  const refused = relayGate(request, { requireJson: true });
  if (refused) return refusal(refused);
  const backend = localBackend();
  const secret = readLocalSecret(backend);
  if (secret === null) return refusal("secret_missing");
  const result = await forwardToBackend(backend, method, path, {
    secret,
    body: await request.text(),
  });
  return result.ok ? passThrough(result.response) : refusal(result.refusal);
}
