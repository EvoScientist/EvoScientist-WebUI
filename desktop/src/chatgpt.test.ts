import { describe, expect, it, vi } from "vitest";
import {
  SIGN_IN_ARGS,
  SIGN_OUT_ARGS,
  signOut,
  startSignIn,
  type ChatgptDeps,
  type SignInRun,
} from "./chatgpt";
import { run, type RunOptions } from "./proc";

const quiet = { info: () => {}, warn: () => {} };
const base: ChatgptDeps = { cwd: process.cwd(), env: process.env, log: quiet };

const URL = "https://auth.openai.com/oauth/authorize?x=1";

// A stand-in for `EvoSci login chatgpt --json`, run by Node: `script` is the body.
function fake(script: string) {
  return (_file: string, _args: string[], opts: RunOptions) =>
    run(process.execPath, ["-e", script], opts);
}

/** A script line that prints one protocol event. */
const say = (event: Record<string, unknown>) =>
  `console.log(JSON.stringify(${JSON.stringify({ protocol: 1, ...event })}));`;

const ON_EOF_CANCELLED = `process.stdin.on("end", () => { ${say({
  event: "error",
  code: "cancelled",
  message: "ChatGPT sign-in was cancelled.",
})} process.exit(1); }); process.stdin.resume();`;

const killPid = vi.fn(async (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
});

describe("startSignIn", () => {
  it("hands out the url, then resolves signed_in", async () => {
    const urls: string[] = [];
    const r = startSignIn("EvoSci", (u) => urls.push(u), {
      ...base,
      spawn: fake(
        `${say({ event: "url", url: URL })} setTimeout(() => { ${say({
          event: "signed_in",
          plan: "plus",
        })} process.exit(0); }, 50);`
      ),
    });
    expect(await r.done).toEqual({ ok: true, plan: "plus" });
    expect(urls).toEqual([URL]);
  });

  it("starts EvoSci with SIGN_IN_ARGS in the given folder and environment", async () => {
    const calls: { file: string; args: string[]; opts: RunOptions }[] = [];
    const env = { ...process.env, EVO_TEST_MARK: "1" };
    const r = startSignIn("/bin/EvoSci", () => {}, {
      ...base,
      cwd: "/data",
      env,
      spawn: (file, args, opts) => {
        calls.push({ file, args, opts });
        return run(
          process.execPath,
          ["-e", say({ event: "signed_in", plan: null })],
          { ...opts, cwd: process.cwd() }
        );
      },
    });
    expect(await r.done).toEqual({ ok: true, plan: null });
    expect(SIGN_IN_ARGS).toEqual(["login", "chatgpt", "--json"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("/bin/EvoSci");
    expect(calls[0].args).toEqual(SIGN_IN_ARGS);
    expect(calls[0].opts.cwd).toBe("/data");
    expect(calls[0].opts.env).toBe(env);
  });

  it("never opens the browser on port_in_use", async () => {
    const onUrl = vi.fn();
    const r = startSignIn("EvoSci", onUrl, {
      ...base,
      spawn: fake(
        `${say({
          event: "error",
          code: "port_in_use",
          message: "Port 1455 is in use.",
        })} process.exit(1);`
      ),
    });
    expect(await r.done).toEqual({
      ok: false,
      code: "port_in_use",
      message: "Port 1455 is in use.",
    });
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("cancel closes stdin and resolves with the core's cancelled", async () => {
    const r: SignInRun = startSignIn("EvoSci", () => r.cancel(), {
      ...base,
      spawn: fake(`${say({ event: "url", url: URL })} ${ON_EOF_CANCELLED}`),
    });
    expect(await r.done).toEqual({
      ok: false,
      code: "cancelled",
      message: "ChatGPT sign-in was cancelled.",
    });
  });

  it("cancel closes stdin, then ends the tree; the outcome is cancelled", async () => {
    killPid.mockClear();
    const r: SignInRun = startSignIn("EvoSci", () => r.cancel(), {
      ...base,
      stopMs: 200,
      kill: killPid,
      spawn: fake(
        `${say({
          event: "url",
          url: URL,
        })} setTimeout(() => process.exit(0), 5000);`
      ),
    });
    expect(await r.done).toEqual({ ok: false, code: "cancelled", message: "" });
    expect(killPid).toHaveBeenCalledTimes(1);
  });

  it("cancel resolves once the process has stopped", async () => {
    killPid.mockClear();
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      stopMs: 200,
      kill: killPid,
      spawn: fake(
        `${say({
          event: "url",
          url: URL,
        })} setTimeout(() => process.exit(0), 5000);`
      ),
    });
    await new Promise((res) => setTimeout(res, 300));
    const stopping = r.cancel();
    expect(killPid).not.toHaveBeenCalled();
    await stopping;
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(await r.done).toMatchObject({ ok: false, code: "cancelled" });
  });

  /** The core still prints `url` after its stdin closed, then cancels. */
  const URL_AFTER_EOF = (url: string) =>
    `process.stdin.on("end", () => { ${say({
      event: "url",
      url,
    })} setTimeout(() => { ${say({
      event: "error",
      code: "cancelled",
      message: "ChatGPT sign-in was cancelled.",
    })} process.exit(1); }, 50); }); process.stdin.resume();`;

  it("never opens a link that arrives after a cancel", async () => {
    const onUrl = vi.fn();
    const lines: string[] = [];
    const r = startSignIn("EvoSci", onUrl, {
      ...base,
      log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      spawn: fake(URL_AFTER_EOF(URL)),
    });
    void r.cancel();
    expect(await r.done).toMatchObject({ ok: false, code: "cancelled" });
    // The link did arrive, and was skipped.
    expect(lines).toContain("chatgpt sign-in: link after a cancel; not opened");
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("a cancelled run stays cancelled whatever link comes after", async () => {
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      spawn: fake(URL_AFTER_EOF("http://auth.openai.com/x")),
    });
    void r.cancel();
    expect(await r.done).toMatchObject({ ok: false, code: "cancelled" });
  });

  it("opens only the first url", async () => {
    const urls: string[] = [];
    const r = startSignIn("EvoSci", (u) => urls.push(u), {
      ...base,
      spawn: fake(
        `${say({ event: "url", url: URL })} ${say({
          event: "url",
          url: `${URL}&again=1`,
        })} ${say({ event: "signed_in", plan: "pro" })}`
      ),
    });
    expect(await r.done).toEqual({ ok: true, plan: "pro" });
    expect(urls).toEqual([URL]);
  });

  it("refuses a link that is not https, and cancels", async () => {
    const onUrl = vi.fn();
    const r = startSignIn("EvoSci", onUrl, {
      ...base,
      spawn: fake(
        `${say({
          event: "url",
          url: "http://auth.openai.com/x",
        })} ${ON_EOF_CANCELLED}`
      ),
    });
    expect(await r.done).toEqual({
      ok: false,
      code: "internal_error",
      message: "EvoSci sent a sign-in link that is not https.",
    });
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("ignores text lines and unknown events", async () => {
    const urls: string[] = [];
    const r = startSignIn("EvoSci", (u) => urls.push(u), {
      ...base,
      spawn: fake(
        `console.log("Signing in..."); ${say({ event: "hello" })} ${say({
          event: "url",
          url: URL,
        })} ${say({ event: "signed_in", plan: "plus" })}`
      ),
    });
    expect(await r.done).toEqual({ ok: true, plan: "plus" });
    expect(urls).toEqual([URL]);
  });

  it("reads an exit without a terminal line as internal_error", async () => {
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      spawn: fake("process.exit(3)"),
    });
    expect(await r.done).toEqual({
      ok: false,
      code: "internal_error",
      message: "EvoSci login exited (code 3).",
    });
  });

  /** Runs `script` and records when the process exits. */
  function watched(script: string) {
    const seen = { exitedAt: 0 };
    const spawn = (_f: string, _a: string[], opts: RunOptions) => {
      const r = run(process.execPath, ["-e", script], opts);
      void r.exited.then(() => (seen.exitedAt = Date.now()));
      return r;
    };
    return { seen, spawn };
  }

  it("answers only once the login has exited after its terminal line", async () => {
    const w = watched(
      `${say({
        event: "signed_in",
        plan: "plus",
      })} setTimeout(() => process.exit(0), 300);`
    );
    const r = startSignIn("EvoSci", () => {}, { ...base, spawn: w.spawn });
    const out = await r.done;
    const answeredAt = Date.now();
    expect(out).toEqual({ ok: true, plan: "plus" });
    expect(w.seen.exitedAt).toBeGreaterThan(0);
    expect(w.seen.exitedAt).toBeLessThanOrEqual(answeredAt);
  });

  it("ends a login that keeps running after its terminal line, keeping its answer", async () => {
    killPid.mockClear();
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      stopMs: 200,
      kill: killPid,
      spawn: fake(
        `${say({
          event: "signed_in",
          plan: "plus",
        })} setTimeout(() => process.exit(0), 5000);`
      ),
    });
    expect(await r.done).toEqual({ ok: true, plan: "plus" });
    expect(killPid).toHaveBeenCalledTimes(1);
  });

  it("answers even when ending a stuck login throws", async () => {
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      stopMs: 100,
      kill: async () => {
        throw new Error("no permission");
      },
      // Ignores the closed stdin, then ends on its own (no process is left).
      spawn: fake(
        `${say({
          event: "signed_in",
          plan: null,
        })} setTimeout(() => process.exit(0), 1500);`
      ),
    });
    expect(await r.done).toEqual({ ok: true, plan: null });
  });

  it("a cancel whose kill throws still resolves, and the run answers at once", async () => {
    const started = Date.now();
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      ceilingMs: 50,
      stopMs: 100,
      kill: async () => {
        throw new Error("no permission");
      },
      // Ignores the closed stdin, then ends on its own.
      spawn: fake(
        `${say({
          event: "url",
          url: URL,
        })} setTimeout(() => process.exit(0), 1500);`
      ),
    });
    await expect(r.cancel()).resolves.toBeUndefined();
    expect(await r.done).toMatchObject({ ok: false, code: "timed_out" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("says when the login exited but its output stayed open", async () => {
    const lines: string[] = [];
    let lineOut: ((l: string) => void) | undefined;
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      stopMs: 50,
      log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      spawn: (_f, _a, opts) => {
        lineOut = opts.onStdoutLine;
        return {
          child: { pid: undefined } as never,
          exited: Promise.resolve({ code: 0, signal: null }),
          closed: new Promise(() => {}),
          closeStdin: () => {},
        };
      },
    });
    await new Promise((res) => setTimeout(res, 10));
    lineOut?.(JSON.stringify({ protocol: 1, event: "signed_in", plan: null }));
    expect(await r.done).toEqual({ ok: true, plan: null });
    expect(lines).toContain(
      "EvoSci login exited, but its output stayed open after its answer"
    );
  });

  it("cancel waits for the exit after ending the tree", async () => {
    const w = watched(
      `${say({
        event: "url",
        url: URL,
      })} setTimeout(() => process.exit(0), 5000);`
    );
    // A kill that returns before the process has gone.
    const lateKill = vi.fn(async (pid: number) => {
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 150);
    });
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      stopMs: 200,
      kill: lateKill,
      spawn: w.spawn,
    });
    await new Promise((res) => setTimeout(res, 300));
    await r.cancel();
    expect(lateKill).toHaveBeenCalledTimes(1);
    expect(w.seen.exitedAt).toBeGreaterThan(0);
  });

  it("logs an unknown event by its name only", async () => {
    const lines: string[] = [];
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
      spawn: fake(
        `${say({ event: "hello", token: "SECRET-1" })} ${say({
          event: "signed_in",
          plan: null,
        })}`
      ),
    });
    await r.done;
    expect(lines).toContain("login event: hello");
    expect(lines.join("\n")).not.toContain("SECRET-1");
  });

  it("reads the output to its end, not only to the exit", async () => {
    // `exit` can come before the last stdout line has been read.
    let closed!: (e: { code: number; signal: null }) => void;
    let lineOut: ((l: string) => void) | undefined;
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      spawn: (_f, _a, opts) => {
        lineOut = opts.onStdoutLine;
        return {
          child: { pid: undefined } as never,
          exited: Promise.resolve({ code: 0, signal: null }),
          closed: new Promise((res) => (closed = res)),
          closeStdin: () => {},
        };
      },
    });
    await new Promise((res) => setTimeout(res, 20));
    lineOut?.(
      JSON.stringify({ protocol: 1, event: "signed_in", plan: "plus" })
    );
    closed({ code: 0, signal: null });
    expect(await r.done).toEqual({ ok: true, plan: "plus" });
  });

  it("gives up after the ceiling as timed_out", async () => {
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      ceilingMs: 200,
      spawn: fake(`${say({ event: "url", url: URL })} ${ON_EOF_CANCELLED}`),
    });
    expect(await r.done).toEqual({
      ok: false,
      code: "timed_out",
      message: "The sign-in was not finished in time.",
    });
  });

  it("answers timed_out only once a stuck login has stopped", async () => {
    killPid.mockClear();
    const r = startSignIn("EvoSci", () => {}, {
      ...base,
      ceilingMs: 100,
      stopMs: 200,
      kill: killPid,
      spawn: fake(
        `${say({
          event: "url",
          url: URL,
        })} setTimeout(() => process.exit(0), 5000);`
      ),
    });
    const out = await r.done;
    expect(out).toEqual({
      ok: false,
      code: "timed_out",
      message: "The sign-in was not finished in time.",
    });
    expect(killPid).toHaveBeenCalledTimes(1);
  });

  it("closeStdinNow closes stdin at once", async () => {
    const r: SignInRun = startSignIn("EvoSci", () => r.closeStdinNow(), {
      ...base,
      spawn: fake(`${say({ event: "url", url: URL })} ${ON_EOF_CANCELLED}`),
    });
    expect(await r.done).toMatchObject({ ok: false, code: "cancelled" });
  });
});

describe("signOut", () => {
  it("starts EvoSci with SIGN_OUT_ARGS, closes stdin and resolves signed_out", async () => {
    const calls: string[][] = [];
    const r = await signOut("EvoSci", {
      ...base,
      spawn: (file, args, opts) => {
        calls.push(args);
        // Answers only once its stdin has closed.
        return fake(
          `process.stdin.on("end", () => { ${say({
            event: "signed_out",
          })} process.exit(0); }); process.stdin.resume();`
        )(file, args, opts);
      },
    });
    expect(r).toEqual({ ok: true });
    expect(SIGN_OUT_ARGS).toEqual(["logout", "chatgpt", "--json"]);
    expect(calls).toEqual([SIGN_OUT_ARGS]);
  });

  it("resolves the core's error", async () => {
    const r = await signOut("EvoSci", {
      ...base,
      spawn: fake(
        `${say({
          event: "error",
          code: "internal_error",
          message: "locked",
        })} process.exit(1);`
      ),
    });
    expect(r).toEqual({ ok: false, code: "internal_error", message: "locked" });
  });

  it("does not wait for output that never closes after the exit", async () => {
    const r = await signOut("EvoSci", {
      ...base,
      stopMs: 100,
      spawn: (_f, _a, opts) => {
        // A grandchild could hold the output open after the exit.
        setTimeout(() =>
          opts.onStdoutLine?.(
            JSON.stringify({ protocol: 1, event: "signed_out" })
          )
        );
        return {
          child: { pid: undefined } as never,
          exited: new Promise((res) =>
            setTimeout(() => res({ code: 0, signal: null }), 20)
          ),
          closed: new Promise(() => {}),
          closeStdin: () => {},
        };
      },
    });
    expect(r).toEqual({ ok: true });
  });

  it("ends a logout that does not answer", async () => {
    killPid.mockClear();
    const r = await signOut("EvoSci", {
      ...base,
      timeoutMs: 200,
      kill: killPid,
      spawn: fake("setTimeout(() => process.exit(0), 5000);"),
    });
    expect(r).toEqual({
      ok: false,
      code: "internal_error",
      message: "EvoSci logout did not answer.",
    });
    expect(killPid).toHaveBeenCalledTimes(1);
  });

  it("reads an exit without a terminal line as internal_error", async () => {
    const r = await signOut("EvoSci", {
      ...base,
      spawn: fake("process.exit(2)"),
    });
    expect(r).toEqual({
      ok: false,
      code: "internal_error",
      message: "EvoSci logout exited (code 2).",
    });
  });
});
