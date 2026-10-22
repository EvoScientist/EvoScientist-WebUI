import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withTimeout } from "./proc";
import {
  isSecretName,
  pickUiPort,
  startUiServer,
  uiServerEnv,
  withLoopbackNoProxy,
} from "./uiServer";

const quiet = { info: () => {}, warn: () => {} };
const ENTRY = join(__dirname, "..", "resources", "ui-entry.mjs");

describe("uiServerEnv", () => {
  const target = {
    uiPort: 4718,
    backendUrl: "http://127.0.0.1:6200",
    dataDir: "/d",
    configDir: join("/c", "evoscientist"),
    serverJs: "/app/ui/server.js",
  };

  it("drops secrets and sets what the WebUI's server needs", () => {
    const env = uiServerEnv(
      {
        PATH: "p",
        OPENAI_API_KEY: "x",
        GITHUB_TOKEN: "x",
        my_password: "x",
        SSH_KEY: "x",
        NODE_USE_ENV_PROXY: "1",
        no_proxy: "corp.example",
      },
      target
    );
    expect(env).toEqual({
      PATH: "p",
      NODE_USE_ENV_PROXY: "1",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "4718",
      EVOSCIENTIST_LANGGRAPH_DEV_PORT: "6200",
      EVOSCIENTIST_DATA_DIR: "/d",
      XDG_CONFIG_HOME: "/c",
      NO_PROXY: "corp.example,127.0.0.1,localhost,::1",
      no_proxy: "corp.example,127.0.0.1,localhost,::1",
      EVOSCIENTIST_UI_SERVER_JS: "/app/ui/server.js",
    });
  });

  it("matches the core's secret rule", () => {
    expect(
      [
        "ANTHROPIC_API_KEY",
        "HF_TOKEN",
        "CLIENT_SECRET",
        "DB_PASSWORD",
        "X_KEY",
      ].every(isSecretName)
    ).toBe(true);
    expect(
      ["PATH", "HOME", "KEYBOARD", "NODE_OPTIONS", "HTTPS_PROXY"].some(
        isSecretName
      )
    ).toBe(false);
  });

  it("keeps NO_PROXY entries and adds each loopback name once", () => {
    expect(withLoopbackNoProxy(undefined)).toBe("127.0.0.1,localhost,::1");
    expect(withLoopbackNoProxy(" a , 127.0.0.1 ")).toBe(
      "a,127.0.0.1,localhost,::1"
    );
  });
});

describe("pickUiPort", () => {
  let held: Server | null = null;
  afterEach(() => held?.close());

  it("falls back to a free port when the fixed one is taken", async () => {
    held = createServer();
    await new Promise<void>((r) => held!.listen(0, "127.0.0.1", r));
    const taken = (held.address() as { port: number }).port;
    const r = await pickUiPort(taken);
    expect(r.fallback).toBe(true);
    expect(r.port).not.toBe(taken);
  });
});

describe("startUiServer with the entry script", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evosci-ui-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function start(serverSource: string) {
    const serverJs = join(dir, "server.mjs");
    writeFileSync(serverJs, serverSource);
    const { port } = await pickUiPort(0);
    return startUiServer({
      execPath: process.execPath,
      entryScript: ENTRY,
      cwd: dir,
      env: {
        ...process.env,
        PORT: String(port),
        EVOSCIENTIST_UI_SERVER_JS: serverJs,
      },
      port,
      log: quiet,
    });
  }

  const SERVER =
    "import http from 'node:http'; http.createServer((q, r) => r.end('ui')).listen(Number(process.env.PORT), '127.0.0.1');";

  it(
    "loads an ES module server.js, answers, and exits when stopped",
    { timeout: 30_000 },
    async () => {
      const ui = await start(SERVER);
      await ui.whenAnswering(10_000);
      const t = Date.now();
      await ui.stop();
      expect(Date.now() - t).toBeLessThan(4_000); // closed stdin, not the 5 s kill
      expect(await withTimeout(ui.exited, 5_000)).not.toBe("timeout");
    }
  );

  it("rejects whenAnswering when server.js fails to load", async () => {
    const ui = await start("throw new Error('broken bundle');");
    await expect(ui.whenAnswering(10_000)).rejects.toThrow(/exited/);
  });
});
