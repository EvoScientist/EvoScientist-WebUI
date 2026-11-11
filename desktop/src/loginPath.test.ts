import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
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
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("gives up on a shell that never prints the end marker", async () => {
    const pidFile = join(home, "pid");
    const script = `printf '%s' '${START}'; sleep 30 & echo $! > '${pidFile}'; sleep 30`;
    expect(await probeShell("/bin/sh", script, 600, END, env)).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });

  it("is null for a shell that cannot start or ends without the marker", async () => {
    expect(
      await probeShell("/no/such/shell", "true", 5_000, END, env)
    ).toBeNull();
    expect(await probeShell("/bin/sh", "exit 3", 5_000, END, env)).toBeNull();
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
