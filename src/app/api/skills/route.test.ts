import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A skills folder of the test's own: the real ones are the user's.
const dirs = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@/lib/server/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/skills")>()),
  SKILL_DIRS: dirs.list,
  recordUninstall: vi.fn(async () => {}),
}));
// No user config: only loopback names and this machine's own addresses.
vi.mock("@/lib/server/coreConfig", () => ({
  readCoreConfig: vi.fn(() => ({ port: 6174, allowedOrigins: [] })),
}));

import { DELETE, GET } from "./route";
import { recordUninstall } from "@/lib/server/skills";

const SAME_ORIGIN = { host: "localhost:4716", "sec-fetch-site": "same-origin" };
// A browser's DELETE carries its Origin, which must match the Host.
const SAME_ORIGIN_DELETE = { ...SAME_ORIGIN, origin: "http://localhost:4716" };
// A page that rebound its own name to this machine: same-origin to the
// browser, but its name in the Host.
const REBOUND = {
  host: "rebind.example:4716",
  origin: "http://rebind.example:4716",
  "sec-fetch-site": "same-origin",
};
const CROSS_SITE = {
  host: "localhost:4716",
  origin: "http://evil.example",
  "sec-fetch-site": "cross-site",
};

const request = (method: string, headers: Record<string, string>, query = "") =>
  new NextRequest(`http://localhost:4716/api/skills${query}`, {
    method,
    headers,
  });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-route-"));
  mkdirSync(join(root, "victim"));
  writeFileSync(
    join(root, "victim", "SKILL.md"),
    "---\nname: victim\ndescription: A skill to keep\n---\n"
  );
  dirs.list.splice(0, dirs.list.length, root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(recordUninstall).mockClear();
});

// Every Plane-2 route answers its own page only (#97 left these out): a
// rebinding page could list the installed skills and remove them.
describe("/api/skills from another origin", () => {
  it("lists nothing to a rebinding page or another site", async () => {
    expect((await GET(request("GET", REBOUND))).status).toBe(403);
    expect((await GET(request("GET", CROSS_SITE))).status).toBe(403);
  });

  it("removes nothing for a rebinding page or another site", async () => {
    for (const headers of [REBOUND, CROSS_SITE]) {
      const res = await DELETE(request("DELETE", headers, "?name=victim"));
      expect(res.status).toBe(403);
    }
    expect(existsSync(join(root, "victim"))).toBe(true);
    expect(recordUninstall).not.toHaveBeenCalled();
  });
});

describe("/api/skills from its own page", () => {
  it("lists the installed skills", async () => {
    const res = await GET(request("GET", SAME_ORIGIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name)).toEqual(["victim"]);
  });

  it("uninstalls a skill", async () => {
    const res = await DELETE(
      request("DELETE", SAME_ORIGIN_DELETE, "?name=victim")
    );
    expect(res.status).toBe(200);
    expect(existsSync(join(root, "victim"))).toBe(false);
    expect(recordUninstall).toHaveBeenCalledWith("victim");
  });
});
