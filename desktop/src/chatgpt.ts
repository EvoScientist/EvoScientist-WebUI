// The core's ChatGPT sign-in, run the way `deploy --json` is: `EvoSci login
// chatgpt --json` binds the callback port, prints the sign-in link (`url`),
// which the app opens in the browser, and ends with one `signed_in` or
// `error` line. Closing its stdin cancels it. `EvoSci logout chatgpt --json`
// removes the stored token and ends with `signed_out` or `error`.
import { parseChatgptEvent } from "./lines";
import { killTree, run, withTimeout, type Logger } from "./proc";

export const SIGN_IN_ARGS = ["login", "chatgpt", "--json"];
export const SIGN_OUT_ARGS = ["logout", "chatgpt", "--json"];
/** How long the login gets after its stdin closes before its tree is ended. */
export const SIGN_IN_STOP_MS = 5_000;
/** The core gives up after 300 s; the app waits a little longer, then cancels. */
export const SIGN_IN_CEILING_MS = 330_000;
export const SIGN_OUT_MS = 30_000;

export type SignInOutcome =
  | { ok: true; plan: string | null }
  | { ok: false; code: string; message: string };

export type SignOutOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface SignInRun {
  /** The terminal line (`internal_error` when EvoSci exits without one),
   *  given once the process has gone, or after the bounded attempts to end
   *  it (a failed kill is logged). */
  done: Promise<SignInOutcome>;
  /** Closes stdin (the core answers `cancelled`), then ends the tree when it
   *  has not exited after SIGN_IN_STOP_MS. Resolves once the process has
   *  gone (or was ended), so a quit never leaves it holding the port; safe
   *  to repeat. */
  cancel(): Promise<void>;
  /** The end of the session: closes stdin and returns. */
  closeStdinNow(): void;
}

export interface ChatgptDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
  /** Starts the process; `run` from proc.ts, replaceable in tests. */
  spawn?: typeof run;
  kill?: (pid: number) => Promise<void>;
  ceilingMs?: number;
  stopMs?: number;
  /** The logout's time limit. */
  timeoutMs?: number;
}

/** The host of a link, for the log; the link itself is not needed there. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "not a URL";
  }
}

const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

/** Starts `EvoSci login chatgpt --json`; `onUrl` gets the first https link. */
export function startSignIn(
  evosci: string,
  onUrl: (url: string) => void,
  deps: ChatgptDeps
): SignInRun {
  const spawnFn = deps.spawn ?? run;
  const kill = deps.kill ?? ((pid: number) => killTree(pid, deps.log));
  const stopMs = deps.stopMs ?? SIGN_IN_STOP_MS;
  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let stopping: Promise<void> | null = null;
  let urlSeen = false;
  let resolveDone!: (o: SignInOutcome) => void;
  const done = new Promise<SignInOutcome>((r) => (resolveDone = r));
  let ceiling: ReturnType<typeof setTimeout> | null = null;

  const TIMED_OUT: SignInOutcome = {
    ok: false,
    code: "timed_out",
    message: "The sign-in was not finished in time.",
  };
  const settle = (answer: SignInOutcome) => {
    if (settled) return;
    settled = true;
    // After the ceiling, the core's `cancelled` (or none) is the timeout.
    const o = timedOut && !answer.ok ? TIMED_OUT : answer;
    if (ceiling) clearTimeout(ceiling);
    deps.log.info(
      `chatgpt sign-in: ${o.ok ? `signed in (${o.plan ?? "no plan"})` : o.code}`
    );
    // The run is answered once its process has gone: until then it may hold
    // the port, and a quit must still be able to wait for it.
    void (async () => {
      try {
        if ((await withTimeout(proc.closed, stopMs)) !== "timeout") return;
        if (exitedYet) {
          deps.log.warn(
            "EvoSci login exited, but its output stayed open after its answer"
          );
          return;
        }
        // A cancel already under way (the ceiling, a refused link) logs its own.
        if (!cancelled)
          deps.log.warn(
            "EvoSci login did not exit after its answer; ending it"
          );
        await cancel();
      } catch (e) {
        deps.log.warn(`ending EvoSci login failed: ${e}`);
      } finally {
        resolveDone(o);
      }
    })();
  };

  const proc = spawnFn(evosci, SIGN_IN_ARGS, {
    cwd: deps.cwd,
    env: deps.env,
    onStdoutLine: (line) => {
      const ev = parseChatgptEvent(line);
      if (!ev) {
        if (line.trim()) deps.log.info(`login: ${line}`);
        return;
      }
      if (settled) return;
      switch (ev.event) {
        case "url":
          if (urlSeen) return;
          urlSeen = true;
          deps.log.info(`chatgpt sign-in: url (${hostOf(ev.url)})`);
          // The core prints the link before it notices a cancel: a page
          // whose sign-in is already gone is not opened, and the run ends
          // as cancelled whatever the link is.
          if (cancelled) {
            deps.log.info("chatgpt sign-in: link after a cancel; not opened");
            return;
          }
          if (!isHttps(ev.url)) {
            settle({
              ok: false,
              code: "internal_error",
              message: "EvoSci sent a sign-in link that is not https.",
            });
            void cancel();
            return;
          }
          onUrl(ev.url);
          return;
        case "signed_in":
          return settle({ ok: true, plan: ev.plan });
        case "error":
          return settle({ ok: false, code: ev.code, message: ev.message });
        default:
          // By name: an unknown event's fields are not for the log.
          deps.log.info(
            `login event: ${ev.event === "other" ? ev.raw.event : ev.event}`
          );
      }
    },
    onStderrLine: (line) => deps.log.info(`login stderr: ${line}`),
  });

  let exitedYet = false;
  void proc.exited.then(() => (exitedYet = true));

  function cancel(): Promise<void> {
    proc.closeStdin();
    cancelled = true;
    stopping ??= stop();
    return stopping;
  }

  /** Waits for the exit; past `stopMs` ends the tree and waits for the exit
   *  again, as a kill can return before the process has gone. */
  async function stop(): Promise<void> {
    if ((await withTimeout(proc.exited, stopMs)) !== "timeout") return;
    deps.log.warn(
      `EvoSci login did not stop within ${stopMs} ms; ending its tree`
    );
    try {
      if (proc.child.pid) await kill(proc.child.pid);
    } catch (e) {
      deps.log.warn(`ending EvoSci login failed: ${e}`);
    }
    if ((await withTimeout(proc.exited, stopMs)) === "timeout")
      deps.log.warn("EvoSci login still runs after its tree was ended");
  }

  // The answer comes once the login has stopped, so a new sign-in finds the
  // port free.
  ceiling = setTimeout(() => {
    deps.log.warn("chatgpt sign-in: no answer in time; cancelling");
    timedOut = true;
    void cancel().then(() => settle(TIMED_OUT));
  }, deps.ceilingMs ?? SIGN_IN_CEILING_MS);

  // Read to the end of the output: `exit` can come before the last line.
  void proc.closed.then((exit) =>
    // A cancel the core did not answer (it was ended) is still a cancel.
    settle(
      cancelled
        ? { ok: false, code: "cancelled", message: "" }
        : {
            ok: false,
            code: "internal_error",
            message: `EvoSci login exited (code ${exit.code}).`,
          }
    )
  );

  return {
    done,
    cancel,
    closeStdinNow: () => {
      cancelled = true;
      proc.closeStdin();
    },
  };
}

/** Runs `EvoSci logout chatgpt --json` to its terminal line. */
export async function signOut(
  evosci: string,
  deps: ChatgptDeps
): Promise<SignOutOutcome> {
  const spawnFn = deps.spawn ?? run;
  const kill = deps.kill ?? ((pid: number) => killTree(pid, deps.log));
  let outcome: SignOutOutcome | null = null;
  const proc = spawnFn(evosci, SIGN_OUT_ARGS, {
    cwd: deps.cwd,
    env: deps.env,
    onStdoutLine: (line) => {
      const ev = parseChatgptEvent(line);
      if (!ev) {
        if (line.trim()) deps.log.info(`logout: ${line}`);
        return;
      }
      if (outcome) return;
      if (ev.event === "signed_out") outcome = { ok: true };
      else if (ev.event === "error")
        outcome = { ok: false, code: ev.code, message: ev.message };
    },
    onStderrLine: (line) => deps.log.info(`logout stderr: ${line}`),
  });
  // Logout reads no stdin.
  proc.closeStdin();
  const exit = await withTimeout(proc.exited, deps.timeoutMs ?? SIGN_OUT_MS);
  if (exit === "timeout") {
    deps.log.warn("EvoSci logout did not answer; ending its tree");
    if (proc.child.pid) await kill(proc.child.pid);
    return (
      outcome ?? {
        ok: false,
        code: "internal_error",
        message: "EvoSci logout did not answer.",
      }
    );
  }
  // Read to the end: the last line may come with the exit. Bounded, so a
  // stream something else holds open never keeps the sign-out busy.
  await withTimeout(proc.closed, deps.stopMs ?? SIGN_IN_STOP_MS);
  const result: SignOutOutcome = outcome ?? {
    ok: false,
    code: "internal_error",
    message: `EvoSci logout exited (code ${exit.code}).`,
  };
  deps.log.info(`chatgpt sign-out: ${result.ok ? "signed out" : result.code}`);
  return result;
}
