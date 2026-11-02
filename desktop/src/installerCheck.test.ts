// The installer's running-app check (installer/check-app-running.nsh) runs
// its PowerShell lines as written there, on Windows only: the packaging test
// pins their text, this one what Windows PowerShell does with them. The app
// is a copy of node.exe named EvoScientist.exe in a folder with an
// apostrophe in its path (a user name like O'Brien).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NSH = readFileSync(
  join(__dirname, "..", "installer", "check-app-running.nsh"),
  "utf8"
).replace(/\r\n/g, "\n");

/** The PowerShell command of a macro, as PowerShell receives it. */
function command(macro: string): string {
  const body =
    NSH.match(new RegExp(`^!macro ${macro}\\b[^]*?^!macroend$`, "m"))?.[0] ??
    "";
  const line = body.split("\n").find((l) => l.includes('"$PowerShellPath"'));
  const cmd = line?.match(/ -C "(.*)"`$/)?.[1];
  if (!cmd) throw new Error(`no PowerShell command in ${macro}`);
  return cmd.replace(/\$\$/g, "$");
}

describe.runIf(process.platform === "win32")(
  "the installer's PowerShell checks on Windows",
  () => {
    let dir: string;
    let exe: string;
    const running: ChildProcess[] = [];

    beforeAll(() => {
      // The long path, as Windows reports a process's image path (the temp
      // folder may be an 8.3 short name).
      dir = realpathSync.native(mkdtempSync(join(tmpdir(), "evo O'Brien ")));
      exe = join(dir, "EvoScientist.exe");
      copyFileSync(process.execPath, exe);
      mkdirSync(join(dir, "resources"));
      writeFileSync(
        join(dir, "resources", "ui-entry.mjs"),
        "setInterval(() => {}, 1000);\n"
      );
    });

    afterAll(() => {
      for (const p of running) p.kill();
      // The killed processes release the copied executable a moment later.
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          spawnSync("powershell.exe", ["-NoProfile", "-C", "Start-Sleep 1"]);
        }
      }
    });

    /** The macro's exit code: 0 found (or ended), 2 none. */
    const run = (macro: string): number | null =>
      spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-C", command(macro)],
        { env: { ...process.env, EVO_APP_EXE: exe }, timeout: 60_000 }
      ).status;

    function start(args: string[]): ChildProcess {
      const p = spawn(exe, args, { stdio: "ignore" });
      running.push(p);
      return p;
    }

    const ended = (p: ChildProcess) =>
      p.exitCode !== null || p.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((r) => p.once("exit", () => r()));

    it("finds nothing while the app does not run", () => {
      expect(run("EVO_APP_RUNNING")).toBe(2);
      expect(run("EVO_ANY_RUNNING")).toBe(2);
      expect(run("EVO_END_ALL")).toBe(2);
    }, 120_000);

    it("finds the app and ends it", async () => {
      const app = start(["-e", "setInterval(() => {}, 1000)"]);
      expect(run("EVO_APP_RUNNING")).toBe(0);
      expect(run("EVO_ANY_RUNNING")).toBe(0);
      expect(run("EVO_END_ALL")).toBe(0);
      await ended(app);
      expect(run("EVO_ANY_RUNNING")).toBe(2);
    }, 120_000);

    it("leaves a UI server out of the app, but not out of what must end", async () => {
      const ui = start([join(dir, "resources", "ui-entry.mjs")]);
      expect(run("EVO_APP_RUNNING")).toBe(2);
      expect(run("EVO_ANY_RUNNING")).toBe(0);
      expect(run("EVO_END_ALL")).toBe(0);
      await ended(ui);
      expect(run("EVO_ANY_RUNNING")).toBe(2);
    }, 120_000);
  }
);
