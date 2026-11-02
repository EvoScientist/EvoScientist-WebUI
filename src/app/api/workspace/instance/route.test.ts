import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { instanceOf } from "@/lib/server/settingsRelay";

let dataDir: string;

const request = (site = "same-origin") =>
  new NextRequest("http://127.0.0.1:4716/api/workspace/instance", {
    headers: { host: "127.0.0.1:4716", "sec-fetch-site": site },
  });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "evo instance route ą-"));
  vi.stubEnv("EVOSCIENTIST_DATA_DIR", dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/workspace/instance", () => {
  it("answers the instance of this machine's backend, from its secret", async () => {
    mkdirSync(join(dataDir, "server"), { recursive: true });
    writeFileSync(join(dataDir, "server", "local-secret"), "s3cr3t\n");

    const res = await GET(request());

    expect(await res.json()).toEqual({ instance: instanceOf("s3cr3t") });
  });

  it("answers null when no backend has run here", async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instance: null });
  });

  it("answers no other site", async () => {
    const res = await GET(request("cross-site"));

    expect(res.status).toBe(403);
  });
});
