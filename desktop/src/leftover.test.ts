import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  processStartTime,
  readUiRecord,
  stopLeftoverUi,
  writeUiRecord,
} from "./leftover";

const quiet = { info: () => {}, warn: () => {} };
const record = { pid: 4242, port: 4718, startTime: "Thu Oct 23 10:00:00 2026" };

describe("stopLeftoverUi", () => {
  it("stops the recorded process when its start time still matches", async () => {
    const kill = vi.fn(async () => {});
    const r = await stopLeftoverUi(record, {
      startTime: async () => record.startTime,
      kill,
      log: quiet,
    });
    expect(r).toBe("stopped");
    expect(kill).toHaveBeenCalledWith(4242);
  });

  it("leaves a reused PID and a gone process alone", async () => {
    const kill = vi.fn(async () => {});
    expect(
      await stopLeftoverUi(record, {
        startTime: async () => "another time",
        kill,
        log: quiet,
      })
    ).toBe("not_ours");
    expect(
      await stopLeftoverUi(record, {
        startTime: async () => null,
        kill,
        log: quiet,
      })
    ).toBe("none");
    expect(
      await stopLeftoverUi(null, {
        startTime: async () => "x",
        kill,
        log: quiet,
      })
    ).toBe("none");
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("the UI server record", () => {
  it("round-trips, and a removed or broken record reads as none", () => {
    const dir = mkdtempSync(join(tmpdir(), "evosci-rec-"));
    const file = join(dir, "ui-server.json");
    writeUiRecord(file, record);
    expect(readUiRecord(file)).toEqual(record);
    writeUiRecord(file, null);
    expect(readUiRecord(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads this process's start time the same way twice", async () => {
    const a = await processStartTime(process.pid);
    expect(a).not.toBeNull();
    expect(await processStartTime(process.pid)).toBe(a);
  });
});
