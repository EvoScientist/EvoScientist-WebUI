// Requests from the main process to the backend on 127.0.0.1 (health, busy and
// job probes). They never go through a proxy: on Windows a system proxy once
// captured loopback requests and made a live backend look idle
// (EvoScientist/EvoScientist#504). A fresh `http.Agent` has no proxy even
// when NODE_USE_ENV_PROXY=1 is set (only Node's global agent reads the
// environment), and Node never reads the OS proxy settings. No `Origin`
// header is sent: the backend's browser boundary refuses an untrusted origin,
// and a request without one passes.
import http from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class LoopbackError extends Error {
  constructor(
    message: string,
    readonly kind: "not_loopback" | "timeout" | "network" | "bad_json"
  ) {
    super(message);
  }
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

/** One JSON request to a loopback URL, with a hard timeout. */
export function loopbackJson(
  url: string,
  opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number }
): Promise<JsonResponse> {
  const target = new URL(url);
  if (target.protocol !== "http:" || !LOOPBACK.has(target.hostname)) {
    return Promise.reject(
      new LoopbackError(`not a loopback URL: ${url}`, "not_loopback")
    );
  }
  const payload =
    opts.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      target,
      {
        method: opts.method ?? "GET",
        agent: new http.Agent({ keepAlive: false }),
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": payload.length,
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text)
            return resolve({ status: res.statusCode ?? 0, body: null });
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(
              new LoopbackError(
                `${url} answered ${res.statusCode} with non-JSON`,
                "bad_json"
              )
            );
          }
        });
        res.on("error", (e) => reject(new LoopbackError(String(e), "network")));
      }
    );
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy();
      reject(
        new LoopbackError(
          `${url} did not answer within ${opts.timeoutMs} ms`,
          "timeout"
        )
      );
    });
    req.on("error", (e) => reject(new LoopbackError(String(e), "network")));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Whether a URL answers at all (any status), for the UI server and `/ok`. */
export function answers(
  url: string,
  timeoutMs: number
): Promise<number | null> {
  const target = new URL(url);
  if (target.protocol !== "http:" || !LOOPBACK.has(target.hostname))
    return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      target,
      { method: "GET", agent: new http.Agent({ keepAlive: false }) },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}
