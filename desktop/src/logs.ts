// The app's own logs: `desktop.log` (the main process, and the stderr of every
// child) and `desktop-ui.log` (the UI server's output), next to the backend's
// `langgraph_dev.log`. Each line is written synchronously, so the line written
// in `session-end` reaches the file before Windows ends the process (D5), and
// a crash report reads every line written so far.
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "./proc";

/** As the core's `_rotate_log_if_needed()` for `langgraph_dev.log`. */
export const LOG_ROTATE_BYTES = 50 * 1024 * 1024;

export const DESKTOP_LOG = "desktop.log";
export const DESKTOP_UI_LOG = "desktop-ui.log";

/** Above `limit` bytes, renames the log to `<name>.1`, replacing an older
 *  backup. Best effort: a failure leaves the log growing until the next start. */
export function rotateIfLarge(
  path: string,
  limit = LOG_ROTATE_BYTES
): "rotated" | "kept" | "failed" {
  try {
    if (statSync(path).size <= limit) return "kept";
    renameSync(path, `${path}.1`);
    return "rotated";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "kept" : "failed";
  }
}

export class FileLog implements Logger {
  private fd: number | null = null;
  private file: string;

  constructor(
    private dir: string,
    readonly name: string,
    private echo: (line: string) => void = () => {}
  ) {
    this.file = join(dir, name);
    this.open(true);
  }

  get path(): string {
    return this.file;
  }

  get folder(): string {
    return this.dir;
  }

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  /** Writes to the same file in another folder from now on (the folder of
   *  `ready.log_file`), rotating it there first. Nothing happens when the
   *  folder is the same one. */
  moveTo(dir: string): void {
    if (join(dir, this.name) === this.file) return;
    this.info(`log continues in ${join(dir, this.name)}`);
    this.close();
    this.dir = dir;
    this.file = join(dir, this.name);
    this.open(true);
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
    this.fd = null;
  }

  private open(rotate: boolean): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const rotated = rotate ? rotateIfLarge(this.file) : "kept";
      this.fd = openSync(this.file, "a");
      if (rotated !== "kept")
        this.write("INFO", `log rotation at start: ${rotated}`);
    } catch (e) {
      this.fd = null;
      this.echo(`cannot open ${this.file}: ${String(e)}`);
    }
  }

  private write(level: "INFO" | "WARN", msg: string): void {
    const line = `${new Date().toISOString()} ${level} ${msg}`;
    this.echo(line);
    if (this.fd === null) return;
    try {
      writeSync(this.fd, `${line}\n`);
    } catch {
      // A full disk must not stop the app.
    }
  }
}
