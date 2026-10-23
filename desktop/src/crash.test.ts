import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRASH_KEEP, tail, writeCrashReport } from "./crash";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evosci-crash-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tail", () => {
  it("cuts at a line break and says how much was cut", () => {
    const f = join(dir, "a.log");
    writeFileSync(f, "line one\nline two\nline three\n");
    expect(tail(f, 15)).toBe("(first 14 bytes cut)\nline three\n");
    expect(tail(f)).toBe("line one\nline two\nline three\n");
    expect(tail(join(dir, "missing.log"))).toBe("(cannot read: ENOENT)");
  });
});

describe("writeCrashReport", () => {
  it("holds both versions, the code and the end of each log", () => {
    const log = join(dir, "desktop.log");
    writeFileSync(log, "x".repeat(70 * 1024) + "\nlast line\n");
    const file = writeCrashReport(dir, {
      appVersion: "0.4.0",
      coreVersion: "0.3.8",
      code: "ui_server_exited",
      message: "boom",
      logs: [log, join(dir, "langgraph_dev.log")],
    })!;
    const text = readFileSync(file, "utf8");
    expect(text).toContain("app 0.4.0 (bundled WebUI), core 0.3.8");
    expect(text).toContain("code ui_server_exited");
    expect(text).toContain("last line");
    expect(text).toContain("(cannot read: ENOENT)");
    expect(text.length).toBeLessThan(2 * 64 * 1024 + 1024);
  });

  it(`keeps only the newest ${CRASH_KEEP}`, () => {
    const info = {
      appVersion: "0.4.0",
      coreVersion: null,
      code: "c",
      message: "m",
      logs: [],
    };
    for (let i = 0; i < CRASH_KEEP + 3; i++)
      writeCrashReport(dir, info, new Date(Date.UTC(2026, 9, 23, 10, 0, i)));
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(CRASH_KEEP);
    expect(names[0]).toBe("desktop-crash-20261023-100003-000.txt");
  });
});
