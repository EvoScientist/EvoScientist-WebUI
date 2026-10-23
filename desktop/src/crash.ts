// Crash reports: on a fatal error the app writes the app and core versions,
// the error code and the end of each of the three logs (desktop.log,
// desktop-ui.log, langgraph_dev.log) to a file next to the logs, bounded in
// size, keeping only the newest few.
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export const CRASH_TAIL_BYTES = 64 * 1024;
export const CRASH_KEEP = 10;
const PREFIX = "desktop-crash-";

/** The codes whose error screen comes with a crash report: failures of the
 *  app or the backend. The others describe the machine or the configuration
 *  and come with their own action instead. */
export const FATAL_CODES = new Set([
  "internal_error",
  "backend_start_failed",
  "ccproxy_failed",
  "backend_exited",
  "ui_server_exited",
  "unknown_protocol",
  "version_check_timeout",
  "renderer_gone",
  "uncaught_exception",
]);

/** The last `max` bytes of a file, starting at a line break when cut. */
export function tail(path: string, max = CRASH_TAIL_BYTES): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    return `(cannot read: ${(e as NodeJS.ErrnoException).code ?? e})`;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString("utf8");
    if (size > len) {
      const nl = text.indexOf("\n");
      text = `(first ${size - len} bytes cut)\n${
        nl >= 0 ? text.slice(nl + 1) : text
      }`;
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

export interface CrashInfo {
  appVersion: string;
  coreVersion: string | null;
  code: string;
  message: string;
  detail?: unknown;
  /** The logs whose end goes into the report. */
  logs: string[];
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.(\d+)Z$/, "-$1");

/** Writes the report into `dir` and removes all but the newest CRASH_KEEP.
 *  Returns its path, or null when it could not be written. */
export function writeCrashReport(
  dir: string,
  info: CrashInfo,
  now = new Date()
): string | null {
  const lines = [
    `EvoScientist desktop crash report, ${now.toISOString()}`,
    `app ${info.appVersion} (bundled WebUI), core ${
      info.coreVersion ?? "unknown"
    }`,
    `platform ${process.platform} ${process.arch}`,
    `code ${info.code}`,
    `message ${info.message}`,
  ];
  if (info.detail !== undefined)
    lines.push(`detail ${JSON.stringify(info.detail)}`);
  for (const log of info.logs) {
    lines.push("", `----- end of ${log} -----`, tail(log));
  }
  const file = join(dir, `${PREFIX}${stamp(now)}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${lines.join("\n")}\n`);
  } catch {
    return null;
  }
  pruneCrashReports(dir);
  return file;
}

export function pruneCrashReports(dir: string, keep = CRASH_KEEP): void {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.startsWith(PREFIX) && n.endsWith(".txt"))
      .sort();
  } catch {
    return;
  }
  // The names sort by time; the oldest come first.
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      unlinkSync(join(dir, basename(n)));
    } catch {
      // in use or gone
    }
  }
}
