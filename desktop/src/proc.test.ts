import { describe, expect, it, vi } from "vitest";
import {
  killTree,
  listProcesses,
  parsePs,
  run,
  runCollect,
  treeOf,
  withTimeout,
  type PsRow,
} from "./proc";

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

    it("without a group the shell's child ends too", async () => {
      const { r, child } = await shellWithChild(false);
      try {
        await killTree(r.child.pid!, quiet, process.platform);
        expect(await withTimeout(r.exited, 5000)).not.toBe("timeout");
        await vi.waitFor(() => expect(alive(child)).toBe(false));
      } finally {
        if (alive(child)) process.kill(child, "SIGKILL");
      }
    });
  }
);

describe("parsePs", () => {
  it("reads the pid, the parent and the start time of each line", () => {
    expect(
      parsePs(
        [
          "    1     0 Mon Nov  9 08:00:01 2026",
          "  501     1 Tue Nov 10 17:59:43 2026   ",
          "",
          "70001   501 Wed Nov 11 15:33:01 2026",
          "not a process line",
        ].join("\n")
      )
    ).toEqual([
      { pid: 1, ppid: 0, started: "Mon Nov  9 08:00:01 2026" },
      { pid: 501, ppid: 1, started: "Tue Nov 10 17:59:43 2026" },
      { pid: 70001, ppid: 501, started: "Wed Nov 11 15:33:01 2026" },
    ]);
  });
});

describe("treeOf", () => {
  const row = (pid: number, ppid: number): PsRow => ({
    pid,
    ppid,
    started: `t${pid}`,
  });
  const rows = [
    row(1, 0),
    row(10, 1),
    row(11, 10),
    row(12, 11),
    row(13, 10),
    row(20, 1),
    row(21, 20),
  ];

  it("is the process and everything below it, whatever session each is in", () => {
    expect(
      treeOf(rows, 10)
        .map((r) => r.pid)
        .sort((a, b) => a - b)
    ).toEqual([10, 11, 12, 13]);
  });

  it("leaves out its parent and its siblings' trees", () => {
    const pids = treeOf(rows, 10).map((r) => r.pid);
    for (const other of [1, 20, 21]) expect(pids).not.toContain(other);
  });

  it("is empty for a process that is not listed", () => {
    expect(treeOf(rows, 99)).toEqual([]);
  });

  it("ends on a list whose parent links form a loop", () => {
    expect(
      treeOf([row(5, 6), row(6, 5)], 5)
        .map((r) => r.pid)
        .sort((a, b) => a - b)
    ).toEqual([5, 6]);
  });
});

// A stop that times out ends everything the process started. The
// backend's server is a child of `EvoSci deploy` in a session of its own, so
// a signal to deploy's process group never reaches it.
describe.skipIf(process.platform === "win32")("killTree with a tree", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const end = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  /** A parent that starts `command` in a session of its own, prints that
   *  child's pid and stays. */
  async function parentWith(command: string) {
    const script = `const c = require('child_process').spawn('bash', ['-c', ${JSON.stringify(
      command
    )}], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000)`;
    let child = 0;
    const r = run(node, ["-e", script], {
      cwd: process.cwd(),
      env: process.env,
      onStdoutLine: (l) => (child = Number(l)),
    });
    await vi.waitFor(() => expect(child).toBeGreaterThan(0));
    return { r, child };
  }

  it("lists this process", async () => {
    const rows = await listProcesses();
    expect(rows?.find((r) => r.pid === process.pid)?.ppid).toBe(process.ppid);
  });

  it("ends a child that runs in a session of its own", async () => {
    const { r, child } = await parentWith("sleep 30");
    try {
      await killTree(r.child.pid!, quiet, process.platform);
      expect(await withTimeout(r.exited, 5000)).not.toBe("timeout");
      await vi.waitFor(() => expect(alive(child)).toBe(false));
    } finally {
      end(child);
    }
  });

  it("ends what ignores SIGTERM, after the grace period", async () => {
    const { r, child } = await parentWith('trap "" TERM; sleep 30; :');
    try {
      await killTree(r.child.pid!, quiet, process.platform);
      await vi.waitFor(() => expect(alive(child)).toBe(false));
    } finally {
      end(child);
    }
  }, 20_000);

  it("leaves a process outside the tree alone", async () => {
    const { r, child } = await parentWith("sleep 30");
    const other = run(node, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    try {
      await killTree(r.child.pid!, quiet, process.platform);
      await vi.waitFor(() => expect(alive(child)).toBe(false));
      expect(alive(other.child.pid!)).toBe(true);
    } finally {
      end(child);
      end(other.child.pid!);
    }
  });

  it("never sends SIGKILL to a recorded pid whose start time has changed", async () => {
    // The child survives SIGTERM; by the time of SIGKILL the list shows
    // another start time under its pid, as for a pid the system reused.
    const { r, child } = await parentWith('trap "" TERM; sleep 30; :');
    let calls = 0;
    const list = async () => {
      const rows = await listProcesses();
      return ++calls === 1
        ? rows
        : rows?.map((x) =>
            x.pid === child ? { ...x, started: "another start" } : x
          ) ?? null;
    };
    const warned: string[] = [];
    try {
      await killTree(
        r.child.pid!,
        { info: () => {}, warn: (m) => warned.push(m) },
        process.platform,
        false,
        list
      );
      expect(calls).toBe(2);
      expect(alive(child)).toBe(true);
      expect(warned.join("\n")).toContain(`pid ${child}`);
    } finally {
      for (const row of treeOf((await listProcesses()) ?? [], child))
        end(row.pid);
      end(child);
    }
  }, 20_000);

  it("without a process list it still ends the process", async () => {
    const r = run(node, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    await killTree(
      r.child.pid!,
      quiet,
      process.platform,
      false,
      async () => null
    );
    expect(await withTimeout(r.closed, 5000)).not.toBe("timeout");
  });
});

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
