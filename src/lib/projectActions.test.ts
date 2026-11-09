import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addProject,
  exposureWarnings,
  moveProject,
  movedText,
  projectsReadOnlyReason,
  readMoveSupport,
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

  it("takes a path pasted in quotes, as Windows Explorer copies one", async () => {
    const fetchMock = answer(200, {
      workspace_dir: "C:\\Users\\me\\My Project",
    });

    await addProject(' "C:\\Users\\me\\My Project" ');

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_dir: "C:\\Users\\me\\My Project",
    });
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

describe("moveProject", () => {
  it("sends both folders to the move relay and returns what moved", async () => {
    const fetchMock = answer(200, {
      workspace_dir: "/new/p",
      threads: 3,
      tasks: 1,
      memory: true,
      proposals: 0,
      warnings: ["One task kept its old folder."],
      resumed: false,
      moved: true,
    });

    const result = await moveProject("/old/p", ' "/new/p" ');

    expect(result).toMatchObject({
      ok: true,
      key: "/new/p",
      threads: 3,
      tasks: 1,
      memory: true,
      moved: true,
      warnings: ["One task kept its old folder."],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe("/api/projects/move");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      old: "/old/p",
      new: "/new/p",
    });
  });

  it("reports a move that moved nothing as not moved", async () => {
    answer(200, {
      workspace_dir: "/old/p",
      warnings: ["The old folder is a project again."],
      moved: false,
    });

    const result = await moveProject("/old/p", "/new/p");

    expect(result).toMatchObject({ ok: true, moved: false });
  });

  it("shows the backend's detail for a refused move", async () => {
    answer(409, { error: "busy", detail: "A conversation is running." });

    const result = await moveProject("/old/p", "/new/p");

    expect(result).toEqual({
      ok: false,
      message: "A conversation is running.",
    });
  });

  it.each([
    ["waits to be finished", { pending: true }, true],
    ["may wait to be finished", {}, true],
    ["waits for nothing", { pending: false }, false],
  ])(
    "says whether to try again when a failed move %s",
    async (_label, pending, again) => {
      answer(500, { error: "move_failed", detail: "disk full", ...pending });

      const result = await moveProject("/old/p", "/new/p");

      expect(!result.ok && result.message).toContain("disk full");
      expect(/try again/i.test(!result.ok ? result.message : "")).toBe(again);
    }
  );

  it.each([
    ["doesn't answer in time", 504, "backend_timeout"],
    ["cuts the connection", 502, "backend_unreachable"],
  ])(
    "says the move may still be running when the backend %s",
    async (_label, status, error) => {
      answer(status, { error });

      const result = await moveProject("/old/p", "/new/p");

      expect(!result.ok && result.message).toMatch(/still be running/);
      expect(!result.ok && result.message).toMatch(/try again/);
    }
  );

  it("says the move may still be running when the request to the WebUI is cut", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      })
    );

    const result = await moveProject("/old/p", "/new/p");

    expect(!result.ok && result.message).toMatch(/still be running/);
  });

  it("asks for an update when the backend has no move", async () => {
    answer(404, { detail: "Not Found" });

    const result = await moveProject("/old/p", "/new/p");

    expect(!result.ok && result.message).toMatch(/Update EvoScientist/);
  });
});

describe("readMoveSupport", () => {
  it("is true only when the WebUI's server says the backend can move", async () => {
    answer(200, { supported: true });
    expect(await readMoveSupport()).toBe(true);
    answer(200, { supported: false });
    expect(await readMoveSupport()).toBe(false);
    answer(500, {});
    expect(await readMoveSupport()).toBe(false);
  });
});

describe("movedText", () => {
  const report = {
    key: "/new/p",
    threads: 2,
    tasks: 1,
    memory: true,
    proposals: 0,
    warnings: [],
    resumed: false,
    moved: true,
  };

  it("counts what moved", () => {
    const text = movedText("p", report);

    expect(text).toContain("2 conversations");
    expect(text).toContain("1 scheduled task");
    expect(text).toContain("memory");
    expect(text).not.toContain("AutoSkills");
  });

  it("says a move asked before is finished", () => {
    expect(movedText("p", { ...report, resumed: true })).toMatch(/Finished/);
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
