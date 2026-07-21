import { describe, expect, it } from "vitest";
import { formatTime, timeBucketFor } from "@/lib/time";

const now = new Date("2026-07-21T22:30:00");

describe("timeBucketFor", () => {
  it("buckets a timestamp from earlier the same period as today", () => {
    expect(timeBucketFor(new Date("2026-07-21T22:24:00"), now)).toBe("today");
  });

  it("buckets a timestamp slightly newer than the now snapshot as today", () => {
    expect(timeBucketFor(new Date("2026-07-21T22:30:30"), now)).toBe("today");
  });

  it("buckets one day old as yesterday", () => {
    expect(timeBucketFor(new Date("2026-07-20T10:00:00"), now)).toBe(
      "yesterday"
    );
  });

  it("uses calendar boundaries instead of rolling 24-hour windows", () => {
    const justAfterMidnight = new Date("2026-07-21T00:01:00");
    const justBeforeMidnight = new Date("2026-07-20T23:59:00");
    expect(timeBucketFor(justBeforeMidnight, justAfterMidnight)).toBe(
      "yesterday"
    );
    expect(formatTime(justBeforeMidnight, justAfterMidnight)).toBe("Yesterday");
  });

  it("buckets three days old as week", () => {
    expect(timeBucketFor(new Date("2026-07-18T22:30:00"), now)).toBe("week");
  });

  it("buckets eight days old as older", () => {
    expect(timeBucketFor(new Date("2026-07-13T22:30:00"), now)).toBe("older");
  });

  it("places invalid timestamps in the safe fallback bucket", () => {
    expect(timeBucketFor(new Date("invalid"), now)).toBe("older");
  });
});
