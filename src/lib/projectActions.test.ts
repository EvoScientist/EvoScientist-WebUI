import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addProject,
  exposureWarnings,
  projectsReadOnlyReason,
  removeProject,
} from "./projectActions";

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("addProject", () => {
  it("sends the folder to the WebUI's relay and returns its key", async () => {
    const fetchMock = answer(200, {
      workspace_dir: "/home/you/p",
      host: "127.0.0.1",
      tunnel: false,
    });

    const result = await addProject("~/p");

    expect(result).toEqual({ ok: true, key: "/home/you/p", warnings: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("/api/projects");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workspace_dir: "~/p" });
  });

  it("warns when other machines can reach the backend", async () => {
    answer(200, { workspace_dir: "/p", host: "0.0.0.0", tunnel: true });

    const result = await addProject("/p");

    expect(result.ok && result.warnings).toHaveLength(2);
  });

  it.each([
    ["folder_missing", /never creates one/],
    ["invalid_path", /full path/],
    ["not_loopback", /listens on the network/],
  ])("says what %s means", async (code, text) => {
    answer(code === "not_loopback" ? 403 : 400, { error: code });

    const result = await addProject("/p");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(text);
  });

  it("names the backend's detail when the setup fails", async () => {
    answer(500, { error: "setup_failed", detail: "disk full" });

    const result = await addProject("/p");

    expect(!result.ok && result.message).toContain("disk full");
  });

  it("says when the WebUI server can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const result = await addProject("/p");

    expect(!result.ok && result.message).toMatch(/cannot reach/);
  });
});

describe("removeProject", () => {
  it("returns the tasks that are still on when the backend refuses", async () => {
    answer(409, { error: "enabled_user_crons", cron_ids: ["c1", "c2"] });

    const result = await removeProject("/p");

    expect(result).toMatchObject({ ok: false, cronIds: ["c1", "c2"] });
  });
});

describe("exposureWarnings", () => {
  it("is quiet for a backend on loopback without a tunnel", () => {
    expect(exposureWarnings("127.0.0.1", false)).toEqual([]);
    expect(exposureWarnings(undefined, undefined)).toEqual([]);
  });

  it("names a network bind and a tunnel", () => {
    expect(exposureWarnings("0.0.0.0", false)[0]).toContain("0.0.0.0");
    expect(exposureWarnings("", false)[0]).toContain("every interface");
    expect(exposureWarnings("127.0.0.1", true)[0]).toContain("public tunnel");
  });
});

describe("projectsReadOnlyReason", () => {
  it("is null when the page can change projects", () => {
    expect(projectsReadOnlyReason({ writable: true })).toBeNull();
  });

  it("explains another machine's backend", () => {
    expect(
      projectsReadOnlyReason({ writable: false, reason: "other_backend" })
    ).toMatch(/machine that runs it/);
  });
});
