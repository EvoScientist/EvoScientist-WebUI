import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStageEvent } from "./lines";
import {
  applyStageEvent,
  failedStages,
  parseManifest,
  readSetupRecord,
  runSetup,
  setupArgs,
  setupNeeded,
  writeSetupRecord,
  type Stage,
} from "./setup";

const quiet = { info: () => {}, warn: () => {} };
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "setup-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = JSON.stringify({
  protocol: 1,
  stages: [
    { id: "node", title: "Node.js" },
    { id: "git", title: "Git for Windows" },
    { id: "research-env", title: "Python research environment" },
    { id: "webui", title: "WebUI" },
  ],
});
const line = (o: object) => JSON.stringify({ protocol: 1, ...o });
const event = (o: object) => parseStageEvent(line(o))!;

describe("manifest", () => {
  it("lists the stages in order without webui", () => {
    expect(parseManifest([MANIFEST])).toEqual([
      { id: "node", title: "Node.js", state: "pending" },
      { id: "git", title: "Git for Windows", state: "pending" },
      {
        id: "research-env",
        title: "Python research environment",
        state: "pending",
      },
    ]);
  });

  it("is null for anything else", () => {
    expect(parseManifest(["Usage: EvoSci setup"])).toBeNull();
    expect(parseManifest(['{"stages":[{"title":"x"}]}'])).toBeNull();
  });
});

describe("setupArgs", () => {
  it("skips webui, and adds --cn for mirrors", () => {
    expect(setupArgs(false)).toEqual(["setup", "--json", "--skip", "webui"]);
    expect(setupArgs(true)).toEqual([
      "setup",
      "--json",
      "--skip",
      "webui",
      "--cn",
    ]);
  });
});

describe("applyStageEvent", () => {
  const start = parseManifest([MANIFEST])!;

  it("tracks progress, then each stage's own result", () => {
    let s: Stage[] = start;
    s = applyStageEvent(
      s,
      event({
        stage: "node",
        status: "running",
        progress: 0.4,
        message: "Downloading Node",
      })
    );
    expect(s[0]).toMatchObject({
      state: "running",
      progress: 0.4,
      message: "Downloading Node",
    });
    s = applyStageEvent(s, event({ stage: "node", status: "running" }));
    expect(s[0]).toMatchObject({
      state: "running",
      message: "Downloading Node",
    });
    s = applyStageEvent(
      s,
      event({
        stage: "node",
        status: "error",
        code: "download_failed",
        message: "blocked",
      })
    );
    s = applyStageEvent(
      s,
      event({ stage: "git", status: "done", message: "Git ready" })
    );
    s = applyStageEvent(
      s,
      event({
        stage: "research-env",
        status: "skipped",
        message: "System Python is usable",
      })
    );
    s = applyStageEvent(
      s,
      event({ stage: "webui", status: "skipped", message: "Skipped (--skip)" })
    );
    expect(s.map((x) => [x.id, x.state, x.code, x.progress])).toEqual([
      ["node", "error", "download_failed", undefined],
      ["git", "done", undefined, undefined],
      ["research-env", "skipped", undefined, undefined],
    ]);
    expect(failedStages(s).map((x) => x.id)).toEqual(["node"]);
  });

  it("adds a stage the manifest did not list", () => {
    const s = applyStageEvent(start, event({ stage: "extra", status: "done" }));
    expect(s.at(-1)).toMatchObject({
      id: "extra",
      title: "extra",
      state: "done",
    });
  });
});

describe("setup record", () => {
  it("is the version of the last setup that exited 0", () => {
    const file = join(tempDir(), "setup.json");
    expect(readSetupRecord(file)).toBeNull();
    expect(setupNeeded(null, "0.3.8")).toBe(true);
    writeSetupRecord(file, "0.3.8");
    expect(readSetupRecord(file)).toBe("0.3.8");
    expect(setupNeeded("0.3.8", "0.3.8")).toBe(false);
    expect(setupNeeded("0.3.8", "0.3.9")).toBe(true);
    writeFileSync(file, "{broken");
    expect(readSetupRecord(file)).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("runSetup", () => {
  it("reports the stages as they come and the exit code", async () => {
    const dir = tempDir();
    const evosci = join(dir, "EvoSci");
    const out = [
      line({ stage: "node", status: "running", progress: 0.5 }),
      line({ stage: "node", status: "done" }),
      line({
        stage: "git",
        status: "error",
        code: "download_failed",
        message: "blocked",
      }),
      line({ stage: "research-env", status: "done" }),
      line({ stage: "webui", status: "skipped" }),
    ];
    writeFileSync(
      evosci,
      `#!/bin/sh\necho "$*" > "${dir}/args"\n${out
        .map((l) => `echo '${l}'`)
        .join("\n")}\necho 'progress text' >&2\nexit 1\n`
    );
    chmodSync(evosci, 0o755);
    const updates: string[] = [];
    const r = runSetup(evosci, {
      cn: true,
      stages: parseManifest([MANIFEST])!,
      cwd: dir,
      env: process.env,
      log: quiet,
      onUpdate: (s) => updates.push(s.map((x) => x.state[0]).join("")),
    });
    const { exit, stages } = await r.done;
    expect(exit.code).toBe(1);
    expect(updates).toEqual(["rpp", "dpp", "dep", "ded", "ded"]);
    expect(failedStages(stages).map((s) => s.id)).toEqual(["git"]);
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe(
      "setup --json --skip webui --cn"
    );
  });
});
