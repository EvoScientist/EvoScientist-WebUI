import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** `sleep` with a duration no other test or run uses, so a process found by
 *  its command line is this test's own. */
const RUN = `${process.pid}${Date.now() % 100000}`;
const nap = (seconds: number) => `sleep ${seconds}.${RUN}`;

/** Ends a process a test started, when the test failed to see it end. */
const endNow = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

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
    const script = `echo $$ > '${shellFile}'; head -c 9000000 /dev/zero | tr '\\0' x; ${nap(
      39
    )}`;
    // Null, not "timeout": it did not wait for the time limit.
    expect(await probeShell("/bin/sh", script, 30_000, END, env)).toBeNull();
    const shell = await pidIn(shellFile);
    await vi.waitFor(() => expect(alive(shell)).toBe(false), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(running(nap(39))).toEqual([]);
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
      const toIt = kill.mock.calls.filter(
        ([target]) => Math.abs(Number(target)) === shell
      );
      expect(toIt).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it("sends no signal for a shell that a signal has ended", async () => {
    // Ended by a signal, a shell has no exit code; it has ended all the same.
    const shellFile = join(home, "signalled-shell");
    const kill = vi.spyOn(process, "kill");
    try {
      expect(
        await probeShell(
          "/bin/sh",
          `echo $$ > '${shellFile}'; kill -KILL $$`,
          5_000,
          END,
          env
        )
      ).toBeNull();
      const shell = await pidIn(shellFile);
      const toIt = kill.mock.calls.filter(
        ([target]) => Math.abs(Number(target)) === shell
      );
      expect(toIt).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  // With job control every job has a process group of its own, which the
  // signal to the shell's group does not reach: bash on macOS has it on for
  // an interactive shell even without a terminal, `set -m` turns it on
  // everywhere.
  it.skipIf(!existsSync("/bin/bash"))(
    "ends a background job that has a process group of its own",
    async () => {
      const jobFile = join(home, "own-group-job");
      const script = `set -m; ${nap(
        34
      )} & echo $! > '${jobFile}'; printf '%s' '${END}'; sleep 20`;
      const out = await probeShell("/bin/bash", script, 10_000, END, env);
      expect(out).toMatch(/__E__$/);
      const job = await pidIn(jobFile);
      try {
        await vi.waitFor(() => expect(alive(job)).toBe(false), {
          timeout: 5000,
        });
      } finally {
        endNow(job);
      }
    },
    20_000
  );

  it("has ended the shell when it answers, and never stops one", async () => {
    // No step is left for later: the app may quit right after the answer,
    // and a shell that was only stopped (SIGSTOP) would stay for ever.
    const shellFile = join(home, "answered-shell");
    const kill = vi.spyOn(process, "kill");
    try {
      const out = await probeShell(
        "/bin/sh",
        `echo $$ > '${shellFile}'; ${probeScript(START, END)}`,
        10_000,
        END,
        env
      );
      // Read at once, with nothing awaited in between.
      const signals = kill.mock.calls.map(([target, signal]) => [
        target,
        signal,
      ]);
      const shell = Number(readFileSync(shellFile, "utf8"));
      expect(pathBetween(out as string, START, END)).toBeTruthy();
      // The shell itself is ended for good; what it started gets a hangup.
      expect(signals).toContainEqual([shell, "SIGKILL"]);
      expect(signals).toContainEqual([-shell, "SIGHUP"]);
      expect(signals).not.toContainEqual([-shell, "SIGKILL"]);
      // The shell first: one that got the hangup first could still act on
      // it (a trap in its profile) before it is ended.
      const at = (target: number, signal: string) =>
        signals.findIndex(([t, sig]) => t === target && sig === signal);
      expect(at(shell, "SIGKILL")).toBeLessThan(at(-shell, "SIGHUP"));
      expect(signals.findIndex(([, sig]) => sig === "SIGHUP")).toBeGreaterThan(
        at(shell, "SIGKILL")
      );
      expect(signals.map(([, signal]) => signal)).not.toContain("SIGSTOP");
    } finally {
      kill.mockRestore();
    }
  });

  it("finds an end marker that arrives in two pieces", async () => {
    const script = `printf '%s' '${END.slice(
      0,
      3
    )}'; sleep 0.4; printf '%s' '${END.slice(3)}'; sleep 20`;
    const out = await probeShell("/bin/sh", script, 5_000, END, env);
    expect(out).toMatch(/__E__$/);
  }, 20_000);

  // zsh without a terminal keeps what it starts in its own process group;
  // a job whose parent has gone is then reached only through that group.
  it.skipIf(!existsSync("/bin/zsh"))(
    "ends a job in the shell's process group that is no longer below the shell",
    async () => {
      const jobFile = join(home, "group-job");
      const script = `(${nap(
        35
      )} & echo $! > '${jobFile}'); printf '%s' '${END}'; sleep 20`;
      const out = await probeShell("/bin/zsh", script, 10_000, END, env);
      expect(out).toMatch(/__E__$/);
      const job = await pidIn(jobFile);
      try {
        await vi.waitFor(() => expect(alive(job)).toBe(false), {
          timeout: 5000,
        });
      } finally {
        endNow(job);
      }
    },
    20_000
  );

  it("runs the shell with stdin closed, the two variables that keep it from waiting and the one that tells a profile who asks", async () => {
    expect(PROBE_ENV).toEqual({
      DISABLE_AUTO_UPDATE: "true",
      ZSH_TMUX_AUTOSTART: "false",
      EVOSCIENTIST_RESOLVING_ENVIRONMENT: "1",
    });
    // `read` returns at once on a closed stdin; on an open one it would wait
    // for the full time limit.
    const script = `printf '%s|%s|%s|' "$DISABLE_AUTO_UPDATE" "$ZSH_TMUX_AUTOSTART" "$EVOSCIENTIST_RESOLVING_ENVIRONMENT"; read answer; printf 'read:%s' $?; printf '%s' '${END}'`;
    const began = Date.now();
    const out = await probeShell("/bin/sh", script, 10_000, END, env);
    expect(out).toMatch(/true\|false\|1\|read:1__E__$/);
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("leaves a job the profile started with nohup running and ends the others", async () => {
    // As `pgrep -q some-daemon || nohup some-daemon >/dev/null 2>&1 &` in a
    // profile: the app must not end at each start what was started to stay.
    const keptFile = join(home, "nohup-job");
    const plainFile = join(home, "plain-job");
    const script = [
      `nohup ${nap(41)} >/dev/null 2>&1 & echo $! > '${keptFile}'`,
      `${nap(42)} & echo $! > '${plainFile}'`,
      probeScript(START, END),
    ].join("\n");
    const out = await probeShell("/bin/sh", script, 10_000, END, env);
    const kept = await pidIn(keptFile);
    const plain = await pidIn(plainFile);
    try {
      expect(pathBetween(out as string, START, END)).toBeTruthy();
      await vi.waitFor(() => expect(alive(plain)).toBe(false), {
        timeout: 5000,
      });
      // Still there well after the other one has gone: a job that got the
      // same signal a moment later would be gone by now too.
      await new Promise((r) => setTimeout(r, 700));
      expect(alive(kept)).toBe(true);
    } finally {
      endNow(kept);
      endNow(plain);
    }
  }, 20_000);

  it("ends a job started with nohup too when the shell does not answer in time", async () => {
    // A profile that hangs is ended with everything below it.
    const jobFile = join(home, "nohup-job-of-a-hung-shell");
    const script = [
      `nohup ${nap(43)} >/dev/null 2>&1 & echo $! > '${jobFile}'`,
      "sleep 30",
    ].join("\n");
    expect(await probeShell("/bin/sh", script, 1500, END, env)).toBe("timeout");
    const job = await pidIn(jobFile);
    try {
      await vi.waitFor(() => expect(alive(job)).toBe(false), {
        timeout: 5000,
      });
    } finally {
      endNow(job);
    }
  }, 20_000);

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
    return { login: await import("./loginPath") };
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
    const script = `${nap(
      31
    )} & echo $! > '${jobFile}'; echo $$ > '${shellFile}'; sleep 30`;
    const probe = login.probeShell("/bin/sh", script, 30_000, END, env);
    const shell = await pidIn(shellFile);
    const job = await pidIn(jobFile);
    login.endProbes();
    expect(await probe).toBeNull();
    await gone(shell);
    await gone(job);
  }, 20_000);

  it("ends a job started with nohup too when the app quits during the wait", async () => {
    const { login } = await fresh();
    const jobFile = join(home, "nohup-job-at-quit");
    const script = [
      `nohup ${nap(44)} >/dev/null 2>&1 & echo $! > '${jobFile}'`,
      "sleep 30",
    ].join("\n");
    const probe = login.probeShell("/bin/sh", script, 30_000, END, env);
    const job = await pidIn(jobFile);
    try {
      login.endProbes();
      expect(await probe).toBeNull();
      await gone(job);
    } finally {
      endNow(job);
    }
  }, 20_000);

  it("sends no signal for a shell that has ended, though its probe is still open", async () => {
    // The shell has gone; a job it started keeps the output open, so the
    // probe has no answer yet when the app quits.
    const { login } = await fresh();
    const shellFile = join(home, "open-shell");
    const jobFile = join(home, "open-job");
    const script = `${nap(
      36
    )} & echo $! > '${jobFile}'; echo $$ > '${shellFile}'; exit 3`;
    const probe = login.probeShell("/bin/sh", script, 30_000, END, env);
    const shell = await pidIn(shellFile);
    const job = await pidIn(jobFile);
    await vi.waitFor(() => expect(alive(shell)).toBe(false), {
      timeout: 5000,
    });
    const kill = vi.spyOn(process, "kill");
    try {
      login.endProbes();
      expect(await probe).toBeNull();
      const toIt = kill.mock.calls.filter(
        ([target]) => Math.abs(Number(target)) === shell
      );
      expect(toIt).toEqual([]);
    } finally {
      kill.mockRestore();
      try {
        process.kill(job, "SIGKILL");
      } catch {
        // already gone
      }
    }
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
