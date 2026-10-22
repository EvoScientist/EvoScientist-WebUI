import { describe, expect, it, vi } from "vitest";
import { startDeploy } from "./deploy";
import { run, type RunOptions } from "./proc";

const quiet = { info: () => {}, warn: () => {} };

// A stand-in for `EvoSci deploy --json`, run by Node: `script` is the body.
function fakeDeploy(script: string) {
  const spawn = (_file: string, _args: string[], opts: RunOptions) =>
    run(process.execPath, ["-e", script], opts);
  return spawn;
}

const READY =
  'console.log(JSON.stringify({protocol:1,event:"ready",url:"http://127.0.0.1:6174",owned:true,workspace:"w",data_dir:"d",config_dir:"c",log_file:"l",warnings:[]}))';
const STOP_ON_EOF =
  'process.stdin.on("end", () => { console.log(JSON.stringify({protocol:1,event:"stopped"})); process.exit(0); }); process.stdin.resume();';

describe("startDeploy", () => {
  it("resolves ready and stops when stdin closes", async () => {
    const s = startDeploy("EvoSci", process.cwd(), process.env, {
      log: quiet,
      spawn: fakeDeploy(
        `console.log(JSON.stringify({protocol:1,event:"starting"})); ${READY}; ${STOP_ON_EOF}`
      ),
    });
    const o = await s.outcome;
    expect(o).toMatchObject({
      kind: "ready",
      ready: { url: "http://127.0.0.1:6174", owned: true },
    });
    expect(await s.stop()).toBe("stopped");
  });

  it("resolves the error line before ready", async () => {
    const s = startDeploy("EvoSci", process.cwd(), process.env, {
      log: quiet,
      spawn: fakeDeploy(
        'console.log(JSON.stringify({protocol:1,event:"error",code:"workspace_conflict",message:"m",detail:{workspace:"other"}})); process.exit(1)'
      ),
    });
    expect(await s.outcome).toEqual({
      kind: "error",
      error: {
        event: "error",
        code: "workspace_conflict",
        message: "m",
        detail: { workspace: "other" },
      },
    });
  });

  it("turns an exit before any event into internal_error", async () => {
    const s = startDeploy("EvoSci", process.cwd(), process.env, {
      log: quiet,
      spawn: fakeDeploy("process.exit(3)"),
    });
    expect(await s.outcome).toMatchObject({
      kind: "error",
      error: { code: "internal_error", detail: { exit_code: 3 } },
    });
  });

  it("reports backend_exited after ready, once", async () => {
    const s = startDeploy("EvoSci", process.cwd(), process.env, {
      log: quiet,
      spawn: fakeDeploy(
        `${READY}; setTimeout(() => { console.log(JSON.stringify({protocol:1,event:"error",code:"backend_exited",message:"gone",detail:{}})); process.exit(1); }, 100)`
      ),
    });
    const lost = vi.fn();
    s.onLost(lost);
    await s.outcome;
    await new Promise((r) => setTimeout(r, 1000));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0][0]).toMatchObject({
      code: "backend_exited",
      message: "gone",
    });
  });

  it("ends the tree when deploy ignores its closed stdin", async () => {
    const kill = vi.fn(async () => {});
    const s = startDeploy("EvoSci", process.cwd(), process.env, {
      log: quiet,
      kill,
      spawn: fakeDeploy(
        `${READY}; process.stdin.resume(); setInterval(() => {}, 1000)`
      ),
    });
    await s.outcome;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const stopping = s.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await stopping).toBe("killed");
      expect(kill).toHaveBeenCalledWith(s.pid);
    } finally {
      vi.useRealTimers();
      process.kill(s.pid!); // the mocked kill left the stand-in running
    }
  });
});
