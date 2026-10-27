import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseManifest } from "./setup";
import { UpdateReader, runUpdate, updateArgs, type UpdateView } from "./update";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", "update", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean);

/** The manifest of 0.3.7 on Linux (`git` is Windows-only). */
const STAGES = parseManifest([
  JSON.stringify({
    stages: [
      { id: "node", title: "Node.js" },
      { id: "research-env", title: "Python research environment" },
      { id: "webui", title: "WebUI" },
    ],
  }),
])!;

const line = (v: object) => JSON.stringify({ protocol: 1, ...v });

const quiet = { info: () => {}, warn: () => {} };

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "evo update "));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const exit0 = { code: 0, signal: null };

describe("updateArgs", () => {
  it("always passes the version, skips webui and never passes --yes", () => {
    expect(updateArgs("0.3.8")).toEqual([
      "update",
      "--version",
      "0.3.8",
      "--skip",
      "webui",
      "--json",
    ]);
  });
});

describe("UpdateReader on the core's real output", () => {
  it("success: the update's progress, the setup stages, then done", () => {
    const r = new UpdateReader(STAGES);
    const seen: string[] = [];
    for (const l of fixture("success")) {
      r.push(l);
      seen.push(r.view.stages.map((s) => s.state[0]).join(""));
    }
    expect(r.view.update.message).toBe("Running EvoSci setup");
    expect(r.view.stages.map((s) => [s.id, s.state])).toEqual([
      ["node", "done"],
      ["research-env", "done"],
    ]);
    expect(seen).toContain("rp");
    expect(r.outcome(exit0)).toEqual({
      kind: "done",
      version: "0.3.8",
      message: "Updated EvoScientist 0.3.7 -> 0.3.8",
    });
  });

  it("wait_release: the wait ends on the next update line without waiting_for", () => {
    const r = new UpdateReader(STAGES);
    const lines = fixture("wait_release");
    const waits: (number | null)[] = [];
    for (const l of lines.slice(0, 4)) {
      r.push(l);
      waits.push(r.view.waiting?.length ?? null);
    }
    expect(waits).toEqual([null, null, 1, null]);
    expect(r.cancelFile).toMatch(/evosci-update-.*\/cancel$/);
    for (const l of lines.slice(4)) r.push(l);
    expect(r.outcome(exit0)).toMatchObject({ kind: "done", version: "0.3.8" });
  });

  it("wait_release: the waiting line names the process", () => {
    const r = new UpdateReader(STAGES);
    for (const l of fixture("wait_release").slice(0, 3)) r.push(l);
    expect(r.view.waiting).toEqual([
      {
        pid: expect.any(Number),
        name: "python",
        path: "/home/user/box ąę/home/.local/share/uv/tools/evoscientist/bin/python",
      },
    ]);
    expect(r.view.update.message).toMatch(/^Update pending until you close/);
  });

  it("cancel: environment_busy, and no waiting list after the terminal line", () => {
    const r = new UpdateReader(STAGES);
    for (const l of fixture("cancel")) r.push(l);
    expect(r.view.waiting).toBeNull();
    const o = r.outcome({ code: 1, signal: null });
    expect(o).toMatchObject({ kind: "error", code: "environment_busy" });
    expect(o.kind === "error" && o.detail.waiting_for).toHaveLength(1);
  });

  it("server_running: the core's message and code", () => {
    const r = new UpdateReader(STAGES);
    for (const l of fixture("server_running")) r.push(l);
    expect(r.outcome({ code: 1, signal: null })).toMatchObject({
      kind: "error",
      code: "server_running",
      message: expect.stringContaining("Nothing was changed."),
    });
  });

  it("output without the terminal line is its own outcome", () => {
    const r = new UpdateReader(STAGES);
    for (const l of fixture("success").slice(0, -1)) r.push(l);
    expect(r.outcome(exit0)).toEqual({ kind: "no_terminal_line", exit: exit0 });
  });
});

describe("UpdateReader", () => {
  it("ignores text and lines that are not stage events", () => {
    const r = new UpdateReader(STAGES);
    expect(r.push("Resolved 120 packages")).toBe(false);
    expect(r.push(line({ event: "other" }))).toBe(false);
    expect(r.view.update).toEqual({});
  });

  it("keeps the cancel file of the latest waiting line", () => {
    const r = new UpdateReader(STAGES);
    const wait = (pid: number, file: string) =>
      line({
        stage: "update",
        status: "running",
        detail: {
          waiting_for: [{ pid, name: "python", path: "/p" }],
          cancel_file: file,
        },
      });
    r.push(wait(1, "/t/a/cancel"));
    r.push(wait(2, "/t/b/cancel"));
    expect(r.cancelFile).toBe("/t/b/cancel");
    // A waiting line without a cancel file keeps the last one.
    r.push(
      line({
        stage: "update",
        status: "running",
        detail: { waiting_for: [{ pid: 3, name: "node", path: "/n" }] },
      })
    );
    expect(r.cancelFile).toBe("/t/b/cancel");
    expect(r.view.waiting?.map((b) => b.pid)).toEqual([3]);
    r.push(wait(2, "/t/b/cancel"));
    expect(r.view.waiting?.map((b) => b.pid)).toEqual([2]);
    // An empty list is no wait.
    r.push(
      line({ stage: "update", status: "running", detail: { waiting_for: [] } })
    );
    expect(r.view.waiting).toBeNull();
  });

  it("an error line without a code or message still has both", () => {
    const r = new UpdateReader(STAGES);
    r.push(line({ stage: "update", status: "error" }));
    expect(r.outcome(exit0)).toEqual({
      kind: "error",
      code: "update_failed",
      message: "EvoSci update failed.",
      detail: {},
    });
  });

  it("a done line without detail.version", () => {
    const r = new UpdateReader(STAGES);
    r.push(line({ stage: "update", status: "done" }));
    expect(r.outcome(exit0)).toEqual({
      kind: "done",
      version: null,
      message: undefined,
    });
  });
});

/** A fake `EvoSci` that waits until its cancel file exists. */
function waitingCore(dir: string) {
  const cancel = join(dir, "cancel dir ąę", "cancel");
  const evosci = join(dir, "EvoSci");
  const waitLine = line({
    stage: "update",
    status: "running",
    progress: 0.25,
    detail: {
      waiting_for: [{ pid: 7, name: "python", path: "/env/bin/python" }],
      cancel_file: cancel,
    },
  });
  const busy = line({
    stage: "update",
    status: "error",
    code: "environment_busy",
    message: "Update cancelled",
  });
  writeFileSync(
    evosci,
    [
      "#!/bin/sh",
      `echo "$*" > "${dir}/args"`,
      `if [ -p /dev/stdin ] || [ -S /dev/stdin ]; then echo pipe > "${dir}/stdin"; fi`,
      `mkdir -p "${join(dir, "cancel dir ąę")}"`,
      `echo '${line({ stage: "update", status: "running", progress: 0 })}'`,
      "sleep 0.2",
      `echo '${waitLine}'`,
      `i=0; while [ ! -e "${cancel}" ] && [ $i -lt 30 ]; do sleep 0.05; i=$((i+1)); done`,
      `[ -e "${cancel}" ] && echo '${busy}'`,
      "exit 1",
    ].join("\n") + "\n"
  );
  chmodSync(evosci, 0o755);
  return { evosci, cancel };
}

describe.skipIf(process.platform === "win32")("runUpdate", () => {
  it("cancels as soon as it waits when closing asked before the wait", async () => {
    const dir = tempDir();
    const { evosci, cancel } = waitingCore(dir);
    const views: UpdateView[] = [];
    const r = runUpdate(evosci, {
      version: "0.3.8",
      stages: STAGES,
      cwd: dir,
      env: process.env,
      log: quiet,
      onUpdate: (v) => views.push(v),
    });
    expect(r.waiting()).toBe(false);
    // Nothing to cancel yet: remembered for the waiting line.
    expect(r.cancelWhenWaiting()).toBe(false);
    const { outcome } = await r.done;
    expect(existsSync(cancel)).toBe(true);
    expect(outcome).toMatchObject({ kind: "error", code: "environment_busy" });
    expect(views.some((v) => v.waiting?.[0]?.name === "python")).toBe(true);
    expect(r.waiting()).toBe(false);
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe(
      "update --version 0.3.8 --skip webui --json"
    );
    // Under --json the updater refuses to wait unless stdin is a pipe.
    expect(readFileSync(join(dir, "stdin"), "utf8").trim()).toBe("pipe");
  });

  it("cancels while it waits, once", async () => {
    const dir = tempDir();
    const { evosci, cancel } = waitingCore(dir);
    const touched: string[] = [];
    let run: ReturnType<typeof runUpdate> | null = null;
    run = runUpdate(evosci, {
      version: "0.3.8",
      stages: STAGES,
      cwd: dir,
      env: process.env,
      log: quiet,
      touch: (p) => {
        touched.push(p);
        writeFileSync(p, "");
      },
      onUpdate: (v) => {
        if (v.waiting && run) {
          expect(run.waiting()).toBe(true);
          expect(run.cancelWhenWaiting()).toBe(true);
          expect(run.cancelWhenWaiting()).toBe(false);
        }
      },
    });
    const { outcome } = await run.done;
    expect(touched).toEqual([cancel]);
    expect(outcome).toMatchObject({ code: "environment_busy" });
  });

  it("a cancel file that cannot be created is logged, and the wait goes on", async () => {
    const dir = tempDir();
    const { evosci } = waitingCore(dir);
    const warnings: string[] = [];
    const r = runUpdate(evosci, {
      version: "0.3.8",
      stages: STAGES,
      cwd: dir,
      env: process.env,
      log: { info: () => {}, warn: (m) => warnings.push(m) },
      touch: () => {
        throw new Error("EACCES");
      },
      onUpdate: () => {},
    });
    r.cancelWhenWaiting();
    const { outcome } = await r.done;
    expect(warnings.some((w) => w.includes("EACCES"))).toBe(true);
    // The fake core gave up waiting without its file: no terminal line.
    expect(outcome).toMatchObject({ kind: "no_terminal_line" });
  });

  it("reads lines a helper writes after the process has exited (Windows' handover)", async () => {
    const dir = tempDir();
    const evosci = join(dir, "EvoSci");
    const done = line({
      stage: "update",
      status: "done",
      detail: { version: "0.3.8" },
    });
    writeFileSync(evosci, `#!/bin/sh\n(sleep 0.3; echo '${done}') &\nexit 0\n`);
    chmodSync(evosci, 0o755);
    const r = runUpdate(evosci, {
      version: "0.3.8",
      stages: STAGES,
      cwd: dir,
      env: process.env,
      log: quiet,
      onUpdate: () => {},
    });
    expect((await r.done).outcome).toEqual({
      kind: "done",
      version: "0.3.8",
      message: undefined,
    });
  });
});
