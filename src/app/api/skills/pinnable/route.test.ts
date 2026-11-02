import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/projects")>()),
  projectDir: vi.fn(),
}));
vi.mock("@/lib/server/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/skills")>()),
  listPinnableSkills: vi.fn(),
}));

import { GET } from "./route";
import { projectDir } from "@/lib/server/projects";
import { listPinnableSkills, SKILLS_INSTALL_DIR } from "@/lib/server/skills";

const request = (site = "same-origin", query = "") =>
  new NextRequest(`http://localhost:4716/api/skills/pinnable${query}`, {
    headers: { host: "localhost:4716", "sec-fetch-site": site },
  });
const skill = {
  name: "paper-writing",
  description: "Write papers",
  source: "global" as const,
};

afterEach(() => {
  vi.mocked(projectDir).mockReset();
  vi.mocked(listPinnableSkills).mockReset();
});

describe("GET /api/skills/pinnable", () => {
  it("lists the project's skills/ and the global tier", async () => {
    vi.mocked(projectDir).mockResolvedValue("/ws");
    vi.mocked(listPinnableSkills).mockResolvedValue([skill]);
    const res = await GET(request("same-origin", "?project=p"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ skills: [skill] });
    expect(listPinnableSkills).toHaveBeenCalledWith({
      workspace: "/ws/skills",
      global: SKILLS_INSTALL_DIR,
    });
  });

  it("lists the global tier alone for no project this machine serves", async () => {
    vi.mocked(projectDir).mockRejectedValue(new Error("Not served"));
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
