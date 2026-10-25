import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/skills")>()),
  getCatalog: vi.fn(async () => []),
}));
// No user config: only loopback names and this machine's own addresses.
vi.mock("@/lib/server/coreConfig", () => ({
  readCoreConfig: vi.fn(() => ({ port: 6174, allowedOrigins: [] })),
}));

import { GET } from "./route";
import { getCatalog } from "@/lib/server/skills";

const request = (headers: Record<string, string>, query = "") =>
  new NextRequest(`http://localhost:4716/api/skills/catalog${query}`, {
    headers,
  });

afterEach(() => {
  vi.mocked(getCatalog).mockClear();
});

// The catalog carries what is installed here, and a refresh makes this
// server fetch GitHub: its own page only (#97 left it out).
describe("GET /api/skills/catalog", () => {
  it("answers a rebinding page or another site with 403", async () => {
    const rebound = await GET(
      request(
        {
          host: "rebind.example:4716",
          origin: "http://rebind.example:4716",
          "sec-fetch-site": "same-origin",
        },
        "?refresh=1"
      )
    );
    expect(rebound.status).toBe(403);
    const crossSite = await GET(
      request({
        host: "localhost:4716",
        origin: "http://evil.example",
        "sec-fetch-site": "cross-site",
      })
    );
    expect(crossSite.status).toBe(403);
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it("answers its own page", async () => {
    const res = await GET(
      request({ host: "localhost:4716", "sec-fetch-site": "same-origin" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skills: [] });
  });
});
