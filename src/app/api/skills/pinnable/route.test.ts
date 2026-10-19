import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/workspace")>()),
  getWorkspaceDir: vi.fn(),
}));
vi.mock("@/lib/server/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/skills")>()),
  listPinnableSkills: vi.fn(),
}));

import { GET } from "./route";
import { getWorkspaceDir } from "@/lib/server/workspace";
import { listPinnableSkills, SKILLS_INSTALL_DIR } from "@/lib/server/skills";

const request = (site = "same-origin") =>
  new NextRequest("http://localhost:4716/api/skills/pinnable", {
    headers: { host: "localhost:4716", "sec-fetch-site": site },
  });
const skill = {
  name: "paper-writing",
  description: "Write papers",
  source: "global" as const,
};

afterEach(() => {
  vi.mocked(getWorkspaceDir).mockReset();
  vi.mocked(listPinnableSkills).mockReset();
});

describe("GET /api/skills/pinnable", () => {
  it("lists the workspace's skills/ and the global tier", async () => {
    vi.mocked(getWorkspaceDir).mockResolvedValue("/ws");
    vi.mocked(listPinnableSkills).mockResolvedValue([skill]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ skills: [skill] });
    expect(listPinnableSkills).toHaveBeenCalledWith({
      workspace: "/ws/skills",
      global: SKILLS_INSTALL_DIR,
    });
  });

  it("lists the global tier alone when no backend owns a workspace", async () => {
    vi.mocked(getWorkspaceDir).mockRejectedValue(new Error("No workspace"));
    vi.mocked(listPinnableSkills).mockResolvedValue([skill]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(listPinnableSkills).toHaveBeenCalledWith({
      workspace: null,
      global: SKILLS_INSTALL_DIR,
    });
  });

  it("answers no other site", async () => {
    const res = await GET(request("cross-site"));
    expect(res.status).toBe(403);
    expect(listPinnableSkills).not.toHaveBeenCalled();
  });
});
