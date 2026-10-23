// A UI server this app left behind. On Windows the main process's job object
// ends the UI server with the app (measurement 3), so this matters for macOS
// and Linux (W06). The app records the UI server's PID and start time in
// `userData`; at launch it stops that process only when both still match, so
// a reused PID is never ended.
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./proc";

export interface UiRecord {
  pid: number;
  port: number;
  startTime: string;
}

export function readUiRecord(file: string): UiRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as Partial<UiRecord>;
    return typeof r.pid === "number" &&
      typeof r.port === "number" &&
      typeof r.startTime === "string" &&
      r.startTime !== ""
      ? { pid: r.pid, port: r.port, startTime: r.startTime }
      : null;
  } catch {
    return null;
  }
}

export function writeUiRecord(file: string, r: UiRecord | null): void {
  try {
    if (r) writeFileSync(file, JSON.stringify(r));
    else rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

export const uiRecordPath = (userData: string) =>
  join(userData, "ui-server.json");

/** The process's start time as the OS reports it, or null when it is gone or
 *  the query fails. Only compared with itself, never parsed. */
export function processStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const [file, args] =
    platform === "win32"
      ? [
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ],
        ]
      : ["ps", ["-o", "lstart=", "-p", String(pid)]];
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 15_000, encoding: "utf8" },
      (err, stdout) => {
        const t = stdout?.trim();
        resolve(err || !t ? null : t);
      }
    );
  });
}

export async function stopLeftoverUi(
  record: UiRecord | null,
  deps: {
    startTime: (pid: number) => Promise<string | null>;
    kill: (pid: number) => Promise<void>;
    log: Logger;
  }
): Promise<"none" | "stopped" | "not_ours"> {
  if (!record) return "none";
  const now = await deps.startTime(record.pid);
  if (now === null) return "none";
  if (now !== record.startTime) {
    deps.log.info(
      `pid ${record.pid} from the UI server record is another process now; left alone`
    );
    return "not_ours";
  }
  deps.log.warn(
    `a UI server left behind (pid ${record.pid}, port ${record.port}) still runs; stopping it`
  );
  await deps.kill(record.pid);
  return "stopped";
}
