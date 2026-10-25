import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/skills")>()),
  getSkillDetail: vi.fn(async (name: string) => ({ name, markdown: "# x" })),
}));
// No user config: only loopback names and this machine's own addresses.
vi.mock("@/lib/server/coreConfig", () => ({
  readCoreConfig: vi.fn(() => ({ port: 6174, allowedOrigins: [] })),
}));

import { GET } from "./route";
import { getSkillDetail } from "@/lib/server/skills";

const request = (headers: Record<string, string>) =>
  new NextRequest("http://localhost:4716/api/skills/detail?name=victim", {
    headers,
  });

afterEach(() => {
  vi.mocked(getSkillDetail).mockClear();
});

// An installed skill's SKILL.md is read from this machine: its own page
// only (#97 left it out).
describe("GET /api/skills/detail", () => {
  it("answers a rebinding page or another site with 403", async () => {
    const rebound = await GET(
      request({
        host: "rebind.example:4716",
        origin: "http://rebind.example:4716",
        "sec-fetch-site": "same-origin",
      })
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
    expect(getSkillDetail).not.toHaveBeenCalled();
  });

  it("answers its own page", async () => {
    const res = await GET(
      request({ host: "localhost:4716", "sec-fetch-site": "same-origin" })
    );
    expect(res.status).toBe(200);
    expect(getSkillDetail).toHaveBeenCalledWith("victim");
  });
});
