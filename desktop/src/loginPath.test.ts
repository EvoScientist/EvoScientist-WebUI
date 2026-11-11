import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_SHELLS,
  PROBE_ENV,
  PROBE_TIMEOUT_MS,
  pathBetween,
  probeScript,
  probeShell,
  readLoginPath,
  shellsToTry,
  type Probe,
} from "./loginPath";

const START = "__S__";
const END = "__E__";
/** What a shell prints: its profile's own lines around the block. */
const block = (env: Record<string, string>, before = "", after = "") =>
  `${before}${START}${Object.entries(env)
    .map(([k, v]) => `${k}=${v}\0`)
    .join("")}${END}${after}`;

/** Processes whose whole command line is `command`. */
const running = (command: string) =>
  execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim() === command);

function logs() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m: string) => void lines.push(m),
      warn: (m: string) => void lines.push(m),
    },
  };
}

describe("shellsToTry", () => {
  it("starts with the account's shell, then the fallbacks not tried yet", () => {
    expect(FALLBACK_SHELLS).toEqual(["/bin/zsh", "/bin/bash", "/bin/sh"]);
    expect(shellsToTry("/bin/bash")).toEqual([
      "/bin/bash",
      "/bin/zsh",
      "/bin/sh",
    ]);
    expect(shellsToTry("/bin/zsh")).toEqual([
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
    expect(shellsToTry("/opt/homebrew/bin/fish")).toEqual([
      "/opt/homebrew/bin/fish",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
  });

  it("uses only the fallbacks without an account shell that is a full path", () => {
    for (const shell of [null, "", "zsh", "  "])
      expect(shellsToTry(shell)).toEqual(FALLBACK_SHELLS);
  });
});

describe("probeScript", () => {
  it("prints the environment, NUL-separated, between the two markers", () => {
    const script = probeScript(START, END);
    const [before, after] = script.split("/usr/bin/env -0");
    expect(before).toContain(START);
    expect(after).toContain(END);
  });

  it("keeps the shell running after the end marker, for the app to end it", () => {
    const afterEnd = probeScript(START, END).split(END)[1];
    expect(afterEnd).toMatch(/\/bin\/sleep \d+/);
  });
});

describe("pathBetween", () => {
  it("takes PATH from the block between the markers", () => {
    expect(
      pathBetween(
        block({ HOME: "/Users/a", PATH: "/opt/bin:/usr/bin" }),
        START,
        END
      )
    ).toBe("/opt/bin:/usr/bin");
  });

  it("ignores what a profile prints before and after the markers", () => {
    const out = block(
      { PATH: "/right" },
      "Welcome\nPATH=/wrong-before\0",
      "\0PATH=/wrong-after\0bye\n"
    );
    expect(pathBetween(out, START, END)).toBe("/right");
  });

  it("takes only the variable named PATH", () => {
    const out = block({
      MANPATH: "/man",
      NOT_PATH: "PATH=/inside-a-value",
      PATH: "/right",
      PATH_EXTRA: "/extra",
    });
    expect(pathBetween(out, START, END)).toBe("/right");
  });

  it("keeps a variable with a line break in its value from hiding PATH", () => {
    const out = block({ PS1: "line one\nPATH=/wrong", PATH: "/right" });
    expect(pathBetween(out, START, END)).toBe("/right");
  });

  it("is null without both markers, without PATH or with an empty PATH", () => {
    expect(pathBetween("PATH=/a\0", START, END)).toBeNull();
    expect(pathBetween(`${START}PATH=/a\0`, START, END)).toBeNull();
    expect(pathBetween(`PATH=/a\0${END}`, START, END)).toBeNull();
    expect(pathBetween(block({ HOME: "/h" }), START, END)).toBeNull();
    expect(pathBetween(block({ PATH: "" }), START, END)).toBeNull();
  });
});

describe("readLoginPath", () => {
  /** A probe that answers per shell and records how it was asked. */
  function fakeProbe(
    answers: Record<
      string,
      (start: string, end: string) => string | "timeout" | null
    >
  ) {
    const asked: { shell: string; script: string; timeoutMs: number }[] = [];
    const probe: Probe = async (shell, script, timeoutMs, end) => {
      asked.push({ shell, script, timeoutMs });
      const start = /__EVOSCI_ENV_\w+_START__/.exec(script)?.[0] ?? "";
      return answers[shell]?.(start, end) ?? null;
    };
    return { probe, asked };
  }
  const answer =
    (path: string) =>
    (start: string, end: string): string =>
      `motd\n${start}HOME=/h\0PATH=${path}\0${end}`;

  it("returns the account shell's PATH and says where it came from", async () => {
    const { probe, asked } = fakeProbe({ "/bin/zsh": answer("/a:/b") });
    const l = logs();
    expect(
      await readLoginPath({ accountShell: "/bin/zsh", log: l.log, probe })
    ).toEqual({ path: "/a:/b", shell: "/bin/zsh" });
    expect(asked.map((a) => a.shell)).toEqual(["/bin/zsh"]);
    expect(asked[0].timeoutMs).toBe(PROBE_TIMEOUT_MS);
    expect(asked[0].script).toContain("/usr/bin/env -0");
    expect(l.lines).toEqual(["login shell PATH from /bin/zsh (2 entries)"]);
  });

  it("goes on to the next shell when one does not answer in time", async () => {
    const { probe, asked } = fakeProbe({
      "/bin/zsh": () => "timeout",
      "/bin/bash": answer("/from-bash"),
    });
    const l = logs();
    expect(
      await readLoginPath({ accountShell: "/bin/zsh", log: l.log, probe })
    ).toEqual({ path: "/from-bash", shell: "/bin/bash" });
    expect(asked.map((a) => a.shell)).toEqual(["/bin/zsh", "/bin/bash"]);
    expect(l.lines).toEqual([
      "/bin/zsh did not answer in 10 s; trying /bin/bash",
      "login shell PATH from /bin/bash (1 entries)",
    ]);
  });

  it("goes on when a shell cannot start or prints no PATH", async () => {
    const { probe, asked } = fakeProbe({
      "/usr/local/bin/fish": () => null,
      "/bin/zsh": (s, e) => `${s}HOME=/h\0${e}`,
      "/bin/bash": answer("/from-bash"),
    });
    const l = logs();
    expect(
      await readLoginPath({
        accountShell: "/usr/local/bin/fish",
        log: l.log,
        probe,
      })
    ).toEqual({ path: "/from-bash", shell: "/bin/bash" });
    expect(asked.map((a) => a.shell)).toEqual([
      "/usr/local/bin/fish",
      "/bin/zsh",
      "/bin/bash",
    ]);
    expect(l.lines.slice(0, 2)).toEqual([
      "/usr/local/bin/fish gave no PATH; trying /bin/zsh",
      "/bin/zsh gave no PATH; trying /bin/bash",
    ]);
  });

  it("asks each shell once, and gives up when every one fails", async () => {
    const { probe, asked } = fakeProbe({});
    const l = logs();
    expect(
      await readLoginPath({ accountShell: "/bin/bash", log: l.log, probe })
    ).toBeNull();
    expect(asked.map((a) => a.shell)).toEqual([
      "/bin/bash",
      "/bin/zsh",
      "/bin/sh",
    ]);
    expect(l.lines.at(-1)).toBe(
      "no login shell answered; keeping the inherited PATH"
    );
  });

  it("uses new markers for each shell", async () => {
    const { probe, asked } = fakeProbe({});
    await readLoginPath({ accountShell: null, log: logs().log, probe });
    const markers = asked.map(
      (a) => /__EVOSCI_ENV_\w+_START__/.exec(a.script)?.[0]
    );
    expect(new Set(markers).size).toBe(3);
  });
});

describe.skipIf(process.platform === "win32")("probeShell", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // An empty home, so the developer's own profiles are not read.
  const home = mkdtempSync(join(tmpdir(), "evo-login-path-"));
  const env = { ...process.env, HOME: home };
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("reads a real shell's environment", async () => {
    const out = await probeShell(
      "/bin/sh",
      probeScript(START, END),
      10_000,
      END,
      env
    );
    expect(typeof out === "string" && out.endsWith(END)).toBe(true);
    expect(pathBetween(out as string, START, END)).toBeTruthy();
  });

  it("answers at the end marker and ends what the shell left running", async () => {
    // A profile that leaves a process holding the output open.
    const script = `printf '%s' '${START}'; sleep 30 & printf 'pid=%s' $!; printf '%s' '${END}'; sleep 30`;
    const began = Date.now();
    const out = (await probeShell(
      "/bin/sh",
      script,
      10_000,
      END,
      env
    )) as string;
    expect(Date.now() - began).toBeLessThan(5_000);
    const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), {
      timeout: 5000,
    });
  });

  it("ends a background process a profile started, also when nothing else keeps the shell running", async () => {
    // As a profile's `some-agent &` followed by the probe's own command: the
    // shell would end right after the end marker, and a process it started
    // would then hang under pid 1, out of reach.
    const pidFile = join(home, "background-pid");
    const script = `sleep 321 & echo $! > '${pidFile}'; ${probeScript(
      START,
      END
    )}`;
    const out = await probeShell("/bin/sh", script, 10_000, END, env);
    expect(pathBetween(out as string, START, END)).toBeTruthy();
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), {
      timeout: 5000,
    });
  });

  it("gives up on a shell that never prints the end marker", async () => {
    const pidFile = join(home, "pid");
    const script = `printf '%s' '${START}'; sleep 30 & echo $! > '${pidFile}'; sleep 30`;
    expect(await probeShell("/bin/sh", script, 2000, END, env)).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), {
      timeout: 5000,
    });
  });

  it("is null for a shell that cannot start or ends without the marker", async () => {
    expect(
      await probeShell("/no/such/shell", "true", 5_000, END, env)
    ).toBeNull();
    expect(await probeShell("/bin/sh", "exit 3", 5_000, END, env)).toBeNull();
  });

  it("is null for an account shell that cannot be run at all", async () => {
    // spawn fails at once for these (ENOTDIR, ENOEXEC) instead of reporting
    // an error later; the next shell must still get its turn.
    const text = join(home, "not-a-shell");
    writeFileSync(text, "just text\n", { mode: 0o755 });
    expect(
      await probeShell("/bin/sh/not-a-folder", "true", 5_000, END, env)
    ).toBeNull();
    expect(await probeShell(text, "true", 5_000, END, env)).toBeNull();
  });

  /** The pid a script wrote into `file`, once it is there. */
  const pidIn = async (file: string) => {
    let pid = 0;
    await vi.waitFor(
      () => {
        pid = Number(readFileSync(file, "utf8"));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 10_000 }
    );
    return pid;
  };
  it("gives up on a shell that floods its output without the end marker", async () => {
    // Far more than any environment, and no marker: not kept in memory until
    // the time limit. The shell is ended where it is: it does not get to
    // its next command.
    const shellFile = join(home, "flood-shell");
    const script = `echo $$ > '${shellFile}'; head -c 9000000 /dev/zero | tr '\\0' x; sleep 39`;
    const began = Date.now();
    expect(await probeShell("/bin/sh", script, 30_000, END, env)).toBeNull();
    expect(Date.now() - began).toBeLessThan(15_000);
    const shell = await pidIn(shellFile);
    await vi.waitFor(() => expect(alive(shell)).toBe(false), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(running("sleep 39")).toEqual([]);
  }, 40_000);

  it("sends no signal for a shell that has ended by itself", async () => {
    // Its pid, and the number of its process group, may belong to another
    // process by then.
    const shellFile = join(home, "ended-shell");
    const kill = vi.spyOn(process, "kill");
    try {
      expect(
        await probeShell(
          "/bin/sh",
          `echo $$ > '${shellFile}'; exit 3`,
          5_000,
          END,
          env
        )
      ).toBeNull();
      const shell = await pidIn(shellFile);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const toIt = kill.mock.calls.filter(
        ([target]) => Math.abs(Number(target)) === shell
      );
      expect(toIt).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it("runs the shell with stdin closed and the two variables that keep it from waiting", async () => {
    expect(PROBE_ENV).toEqual({
      DISABLE_AUTO_UPDATE: "true",
      ZSH_TMUX_AUTOSTART: "false",
    });
    // `read` returns at once on a closed stdin; on an open one it would wait
    // for the full time limit.
    const script = `printf '%s|%s|' "$DISABLE_AUTO_UPDATE" "$ZSH_TMUX_AUTOSTART"; read answer; printf 'read:%s' $?; printf '%s' '${END}'`;
    const began = Date.now();
    const out = await probeShell("/bin/sh", script, 10_000, END, env);
    expect(out).toMatch(/true\|false\|read:1__E__$/);
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("passes -ilc, so the login and interactive profiles are read", async () => {
    // bash sets `login_shell` and has `i` in $- only with those options.
    const script = `shopt -q login_shell && printf 'login '; case $- in *i*) printf 'interactive';; esac; printf '%s' '${END}'`;
    expect(await probeShell("/bin/bash", script, 10_000, END, env)).toMatch(
      /login interactive__E__$/
    );
  });
});

// The app quits: its timers and callbacks will not run any more, so what is
// still being asked is ended at once, and nothing new is started. Each test
// loads the module anew: after endProbes() it asks no shell again.
describe.skipIf(process.platform === "win32")("endProbes", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const home = mkdtempSync(join(tmpdir(), "evo-login-path-end-"));
  const env = { ...process.env, HOME: home };
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());
  const fresh = async () => {
    vi.resetModules();
    return {
      proc: await import("./proc"),
      login: await import("./loginPath"),
    };
  };
  /** The pid a script wrote into `file`, once it is there. */
  const pidIn = async (file: string) => {
    let pid = 0;
    await vi.waitFor(
      () => {
        pid = Number(readFileSync(file, "utf8"));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 10_000 }
    );
    return pid;
  };
  const gone = (pid: number) =>
    vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });

  it("ends a shell that is still being asked, with what it started", async () => {
    // A profile that hangs; the job it started runs in a process group of
    // its own, where a signal to the shell's group does not reach it.
    const { login } = await fresh();
    const shellFile = join(home, "hung-shell");
    const jobFile = join(home, "hung-job");
    const script = `sleep 31 & echo $! > '${jobFile}'; echo $$ > '${shellFile}'; sleep 30`;
    const probe = login.probeShell("/bin/sh", script, 30_000, END, env);
    const shell = await pidIn(shellFile);
    const job = await pidIn(jobFile);
    login.endProbes();
    expect(await probe).toBeNull();
    await gone(shell);
    await gone(job);
  }, 20_000);

  it("also ends what a shell started when it has just answered", async () => {
    // The answer is in, the list of its processes is not: the quit comes in
    // between.
    const { login, proc } = await fresh();
    vi.spyOn(proc, "listProcesses").mockReturnValue(new Promise(() => {}));
    const jobFile = join(home, "answered-job");
    const script = `sleep 32 & echo $! > '${jobFile}'; ${login.probeScript(
      START,
      END
    )}`;
    const out = await login.probeShell("/bin/sh", script, 30_000, END, env);
    expect(login.pathBetween(out as string, START, END)).toBeTruthy();
    const job = await pidIn(jobFile);
    expect(alive(job)).toBe(true);
    login.endProbes();
    await gone(job);
  }, 20_000);

  it("stops the shell before it lists its processes, so it starts nothing more", async () => {
    // The list is a moment in time; a command the shell started after it
    // would be missed. Here the list comes back half a second late, and the
    // shell would start `sleep 38` meanwhile.
    const { login, proc } = await fresh();
    const real = proc.listProcesses;
    vi.spyOn(proc, "listProcesses").mockImplementation(async () => {
      const rows = await real();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return rows;
    });
    const script = `printf '%s' '${END}'; sleep 0.25; sleep 38`;
    const out = await login.probeShell("/bin/sh", script, 30_000, END, env);
    expect(out).toBe(END);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(running("sleep 38")).toEqual([]);
  }, 20_000);

  it("asks no further shell afterwards", async () => {
    const { login } = await fresh();
    const asked: string[] = [];
    const lines: string[] = [];
    const found = await login.readLoginPath({
      accountShell: "/bin/zsh",
      log: { info: (m) => void lines.push(m), warn: (m) => void lines.push(m) },
      // The shell being asked is ended by the quit and gives nothing.
      probe: async (shell) => {
        asked.push(shell);
        login.endProbes();
        return null;
      },
    });
    expect(found).toBeNull();
    expect(asked).toEqual(["/bin/zsh"]);
    expect(lines.join("\n")).not.toContain("trying");
  });

  it("starts no shell afterwards", async () => {
    const { login } = await fresh();
    login.endProbes();
    const marker = join(home, "started-after-the-end");
    const script = `echo started > '${marker}'; printf '%s' '${END}'`;
    expect(
      await login.probeShell("/bin/sh", script, 5_000, END, env)
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });
});
