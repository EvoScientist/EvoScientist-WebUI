import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLog, rotateIfLarge } from "./logs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evosci-logs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rotateIfLarge", () => {
  it("keeps one backup above the limit, replacing an older one", () => {
    const log = join(dir, "desktop.log");
    writeFileSync(`${log}.1`, "older backup");
    writeFileSync(log, "x".repeat(11));
    expect(rotateIfLarge(log, 10)).toBe("rotated");
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(11));
    expect(existsSync(log)).toBe(false);
  });

  it("leaves a log at or below the limit, and a missing one", () => {
    const log = join(dir, "desktop.log");
    writeFileSync(log, "x".repeat(10));
    expect(rotateIfLarge(log, 10)).toBe("kept");
    expect(rotateIfLarge(join(dir, "none.log"), 10)).toBe("kept");
  });
});

describe("FileLog", () => {
  it("appends timestamped lines and continues in another folder", () => {
    const log = new FileLog(dir, "desktop.log");
    log.info("first");
    log.warn("second");
    const other = join(dir, "later");
    log.moveTo(other);
    log.info("third");
    log.close();
    const before = readFileSync(join(dir, "desktop.log"), "utf8");
    expect(before).toMatch(/^\S+Z INFO first\n\S+Z WARN second\n/);
    expect(before).toContain(`log continues in ${join(other, "desktop.log")}`);
    expect(readFileSync(join(other, "desktop.log"), "utf8")).toMatch(
      /INFO third\n$/
    );
  });

  it("does not throw when the folder cannot be created", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const echoed: string[] = [];
    const log = new FileLog(join(blocker, "sub"), "desktop.log", (l) =>
      echoed.push(l)
    );
    log.info("still fine");
    expect(echoed.some((l) => l.includes("cannot open"))).toBe(true);
    expect(echoed.some((l) => l.endsWith("INFO still fine"))).toBe(true);
  });
});
