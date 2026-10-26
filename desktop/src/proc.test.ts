import { describe, expect, it, vi } from "vitest";
import { killTree, run, runCollect, withTimeout } from "./proc";

const node = process.execPath;
const quiet = { info: () => {}, warn: () => {} };

describe("run", () => {
  it("splits stdout and stderr into lines and reports the exit", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = run(
      node,
      ["-e", "console.log('a');console.error('b');process.stdout.write('c')"],
      {
        cwd: process.cwd(),
        env: process.env,
        onStdoutLine: (l) => out.push(l),
        onStderrLine: (l) => err.push(l),
      }
    );
    expect(await r.closed).toEqual({ code: 0, signal: null });
    expect(out).toEqual(["a", "c"]);
    expect(err).toEqual(["b"]);
  });

  it("stays open until a grandchild that inherited stdout has finished writing", async () => {
    // The parent exits at once; its detached child keeps the pipe and writes
    // the last line later, as `EvoSci update`'s helper does on Windows.
    const grandchild = "setTimeout(() => console.log('terminal'), 500)";
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
      grandchild
    )}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref()`;
    const out: string[] = [];
    const r = run(node, ["-e", parent], {
      cwd: process.cwd(),
      env: process.env,
      onStdoutLine: (l) => out.push(l),
    });
    await r.exited;
    expect(out).toEqual([]);
    await r.closed;
    expect(out).toEqual(["terminal"]);
  });

  it("lets the child see stdin close", async () => {
    const out: string[] = [];
    const r = run(
      node,
      [
        "-e",
        "process.stdin.on('end', () => console.log('eof')); process.stdin.resume()",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        onStdoutLine: (l) => out.push(l),
      }
    );
    r.closeStdin();
    r.closeStdin();
    await r.closed;
    expect(out).toEqual(["eof"]);
  });

  it("resolves for a file that does not exist", async () => {
    const r = run("/no/such/evosci", [], {
      cwd: process.cwd(),
      env: process.env,
    });
    expect(await r.closed).toEqual({ code: null, signal: null });
  });
});

describe("killTree", () => {
  it("ends a running process", async () => {
    const r = run(node, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    await killTree(r.child.pid!, quiet, process.platform);
    const e = await withTimeout(r.closed, 5000);
    expect(e).not.toBe("timeout");
  });
});

describe.skipIf(process.platform === "win32")(
  "killTree with a process group",
  () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // A shell that starts a long-running child, as install.sh starts uv or
    // curl, and prints that child's pid.
    async function shellWithChild(group: boolean) {
      let child = 0;
      const r = run("bash", ["-c", "sleep 30 & echo $!; wait"], {
        cwd: process.cwd(),
        env: process.env,
        group,
        onStdoutLine: (l) => (child = Number(l)),
      });
      await vi.waitFor(() => expect(child).toBeGreaterThan(0));
      return { r, child };
    }

    it("ends the shell and the child it started", async () => {
      const { r, child } = await shellWithChild(true);
      await killTree(r.child.pid!, quiet, process.platform, true);
      expect(await withTimeout(r.closed, 5000)).not.toBe("timeout");
      await vi.waitFor(() => expect(alive(child)).toBe(false));
    });

    it("without a group only the shell ends, and its child stays", async () => {
      const { r, child } = await shellWithChild(false);
      try {
        await killTree(r.child.pid!, quiet, process.platform);
        await withTimeout(r.exited, 5000);
        expect(alive(child)).toBe(true);
      } finally {
        process.kill(child, "SIGKILL");
      }
    });
  }
);

describe("runCollect", () => {
  it("collects stdout lines and the exit code", async () => {
    const r = await runCollect(
      node,
      ["-e", "console.log('{}'); process.exit(2)"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 10_000,
        log: quiet,
      }
    );
    expect(r).toEqual({ timedOut: false, code: 2, stdout: ["{}"] });
  });

  it("times out and ends the process", async () => {
    const r = await runCollect(
      node,
      ["-e", "console.log('slow'); setInterval(() => {}, 1000)"],
      {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 1000,
        log: quiet,
      }
    );
    expect(r.timedOut).toBe(true);
  });
});
