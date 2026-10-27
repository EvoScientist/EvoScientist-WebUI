import { describe, expect, it } from "vitest";
import {
  CN_SIMPLE,
  PYPI_SIMPLE,
  SIMPLE_JSON,
  lookupNewest,
  newestInRange,
  type Fetch,
} from "./release";

// The Tsinghua mirror's order on 2026-10-27: sorted as strings.
const MIRROR = [
  "0.2.1",
  "0.2.10",
  "0.2.1a1",
  "0.3.6",
  "0.3.7",
  "0.3.8",
  "0.3.9rc1",
  "0.3.10",
  "0.3.9",
  "0.4.0",
];

describe("newestInRange", () => {
  it("compares release numbers, not strings", () => {
    expect(newestInRange(MIRROR, ">=0.3.8,<0.4")).toBe("0.3.10");
  });

  it("skips pre-releases, dev and local versions", () => {
    expect(
      newestInRange(
        ["0.3.8", "0.3.9rc1", "0.3.9.dev2", "0.3.9+x"],
        ">=0.3.8,<0.4"
      )
    ).toBe("0.3.8");
  });

  it("is null when nothing is inside the range", () => {
    expect(newestInRange(["0.3.6", "0.3.7", "0.4.0"], ">=0.3.8,<0.4")).toBe(
      null
    );
    expect(newestInRange([], ">=0.3.8,<0.4")).toBe(null);
  });
});

/** A fetch that answers once and records what it was asked. */
function answering(
  answer: { ok?: boolean; status?: number; body?: unknown } | Error
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: async () => {
        if (answer.body instanceof Error) throw answer.body;
        return answer.body;
      },
    };
  };
  return { fetch, calls };
}

describe("lookupNewest", () => {
  it("asks PyPI's JSON simple API without mirrors", async () => {
    const { fetch, calls } = answering({ body: { versions: MIRROR } });
    const r = await lookupNewest({ fetch, cn: false, range: ">=0.3.8,<0.4" });
    expect(r).toEqual({
      ok: true,
      version: "0.3.10",
      url: `${PYPI_SIMPLE}/evoscientist/`,
    });
    expect(calls).toEqual([
      {
        url: "https://pypi.org/simple/evoscientist/",
        headers: { Accept: SIMPLE_JSON },
      },
    ]);
  });

  it("asks the Tsinghua mirror with mirror: cn", async () => {
    const { fetch, calls } = answering({ body: { versions: MIRROR } });
    const r = await lookupNewest({ fetch, cn: true, range: ">=0.3.8,<0.4" });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe(`${CN_SIMPLE}/evoscientist/`);
    expect(calls[0].url).toBe(
      "https://pypi.tuna.tsinghua.edu.cn/simple/evoscientist/"
    );
  });

  it("fails on an HTTP error", async () => {
    const { fetch } = answering({ ok: false, status: 503 });
    expect(
      await lookupNewest({ fetch, cn: false, range: ">=0.3.8,<0.4" })
    ).toMatchObject({ ok: false, reason: "HTTP 503" });
  });

  it("fails when the network fails", async () => {
    const { fetch } = answering(new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(
      await lookupNewest({ fetch, cn: false, range: ">=0.3.8,<0.4" })
    ).toMatchObject({ ok: false, reason: "net::ERR_INTERNET_DISCONNECTED" });
  });

  it("fails on a body that is not JSON or has no version list", async () => {
    const bad = answering({ body: new SyntaxError("Unexpected token <") });
    expect(
      await lookupNewest({ fetch: bad.fetch, cn: false, range: ">=0.3.8" })
    ).toMatchObject({ ok: false, reason: "Unexpected token <" });
    const html = answering({ body: { files: [] } });
    expect(
      await lookupNewest({ fetch: html.fetch, cn: false, range: ">=0.3.8" })
    ).toMatchObject({ ok: false, reason: "the answer has no version list" });
  });

  it("fails when no release inside the range is listed, with the list", async () => {
    const { fetch } = answering({ body: { versions: ["0.3.7", 8, "0.4.0"] } });
    expect(
      await lookupNewest({ fetch, cn: false, range: ">=0.3.8,<0.4" })
    ).toEqual({
      ok: false,
      reason: "no release inside >=0.3.8,<0.4 is listed",
      url: `${PYPI_SIMPLE}/evoscientist/`,
      listed: ["0.3.7", "0.4.0"],
    });
  });

  it("gives up after the timeout and aborts the request", async () => {
    let signal: AbortSignal | null = null;
    const fetch: Fetch = (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new Error("net::ERR_ABORTED"))
        )
      );
    };
    const r = await lookupNewest({
      fetch,
      cn: false,
      range: ">=0.3.8",
      timeoutMs: 20,
    });
    expect(r).toMatchObject({ ok: false, reason: "no answer within 0.02 s" });
    expect(signal!.aborted).toBe(true);
  });
});
