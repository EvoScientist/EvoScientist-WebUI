// The bundled WebUI's server, run with Electron's own Node
// (ELECTRON_RUN_AS_NODE) through resources/ui-entry.mjs, on a fixed loopback
// port so the WebUI's localStorage (its origin includes the port) survives
// between launches.
import { createServer } from "node:net";
import { basename, dirname } from "node:path";
import { answers } from "./loopback";
import {
  killTree,
  run,
  sleep,
  withTimeout,
  type ExitInfo,
  type Logger,
} from "./proc";

/** Variable names the WebUI never needs, as the core's `_scrubbed_env()`
 *  strips them for `EvoSci --ui webui`. */
export function isSecretName(name: string): boolean {
  const n = name.toUpperCase();
  return (
    n.endsWith("_KEY") ||
    ["API_KEY", "TOKEN", "SECRET", "PASSWORD"].some((h) => n.includes(h))
  );
}

/** NO_PROXY with 127.0.0.1 added: with NODE_USE_ENV_PROXY=1 Node sends even
 *  loopback requests to the proxy unless NO_PROXY lists 127.0.0.1 literally
 *  (`localhost` does not cover it). */
export function withLoopbackNoProxy(value: string | undefined): string {
  const entries = (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  for (const host of ["127.0.0.1", "localhost", "::1"])
    if (!entries.includes(host)) entries.push(host);
  return entries.join(",");
}

export interface UiServerTarget {
  uiPort: number;
  /** `ready.url`: the backend the WebUI talks to. */
  backendUrl: string;
  /** `ready.data_dir` and `ready.config_dir`: the UI server reads the same
   *  local secret and config.yaml as the backend. */
  dataDir: string;
  configDir: string;
  serverJs: string;
}

export function uiServerEnv(
  base: NodeJS.ProcessEnv,
  t: UiServerTarget
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!isSecretName(k)) env[k] = v;
  const noProxy = withLoopbackNoProxy(base.NO_PROXY ?? base.no_proxy);
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(t.uiPort),
    EVOSCIENTIST_LANGGRAPH_DEV_PORT: new URL(t.backendUrl).port || "80",
    EVOSCIENTIST_DATA_DIR: t.dataDir,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    EVOSCIENTIST_UI_SERVER_JS: t.serverJs,
  });
  // The WebUI finds config.yaml under $XDG_CONFIG_HOME/evoscientist.
  if (basename(t.configDir) === "evoscientist")
    env.XDG_CONFIG_HOME = dirname(t.configDir);
  return env;
}

/** The fixed port when it is free on 127.0.0.1, else a free one. */
export async function pickUiPort(
  preferred: number
): Promise<{ port: number; fallback: boolean }> {
  const tryListen = (port: number) =>
    new Promise<number | null>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const got = (srv.address() as { port: number }).port;
        srv.close(() => resolve(got));
      });
    });
  const fixed = await tryListen(preferred);
  if (fixed !== null) return { port: fixed, fallback: false };
  const free = await tryListen(0);
  if (free === null) throw new Error("no free loopback port");
  return { port: free, fallback: true };
}

export interface UiServer {
  url: string;
  port: number;
  /** The process exited (for any reason). */
  exited: Promise<ExitInfo>;
  /** Resolves once the server answers `/` (any status below 500), or rejects
   *  when it exits first or takes longer than `timeoutMs`. */
  whenAnswering(timeoutMs: number): Promise<void>;
  /** Closes stdin, then ends the tree after 5 s. */
  stop(): Promise<void>;
  /** The end of the session, synchronous: close stdin and return (D5). */
  closeStdinNow(): void;
  pid: number | undefined;
}

export function startUiServer(opts: {
  execPath: string;
  entryScript: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  port: number;
  log: Logger;
}): UiServer {
  const url = `http://127.0.0.1:${opts.port}/`;
  const proc = run(opts.execPath, [opts.entryScript], {
    cwd: opts.cwd,
    env: opts.env,
    extraStdio: ["ipc"],
    onStdoutLine: (l) => opts.log.info(`ui: ${l}`),
    onStderrLine: (l) => opts.log.info(`ui stderr: ${l}`),
  });
  let gone = false;
  proc.exited.then((e) => {
    gone = true;
    opts.log.info(`ui server exited (code ${e.code}, signal ${e.signal})`);
  });
  // Closing stdin is the stop signal. The parent never disconnects the IPC
  // channel on a normal stop: after a parent-side disconnect Node emits no
  // `close` for the child. The channel still ends the server when the app
  // itself dies.
  const detach = () => {
    proc.closeStdin();
    if (proc.child.connected) proc.child.disconnect();
  };
  return {
    url,
    port: opts.port,
    pid: proc.child.pid,
    exited: proc.exited,
    async whenAnswering(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (gone) throw new Error("the UI server exited before it answered");
        const status = await answers(url, 2_000);
        if (status !== null && status < 500) return;
        await sleep(250);
      }
      throw new Error(`the UI server did not answer within ${timeoutMs} ms`);
    },
    async stop() {
      proc.closeStdin();
      if (
        (await withTimeout(proc.closed, 5_000)) === "timeout" &&
        proc.child.pid
      ) {
        opts.log.warn("ui server did not exit within 5 s; ending its tree");
        await killTree(proc.child.pid, opts.log);
      }
    },
    closeStdinNow: detach,
  };
}
