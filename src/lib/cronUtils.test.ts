// Scheduled tasks run in the time zone their cron carries. A cron created
// without one is interpreted in UTC by the server, so labels must say which
// clock a schedule follows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserTimeZone, scheduleLabel, timeZoneLabel } from "./cronUtils";

// Captured before any spy, so a second stub in one test still reaches it.
const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

function stubBrowserTimeZone(timeZone: string | undefined) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
    function (this: Intl.DateTimeFormat) {
      return {
        ...realResolvedOptions.call(this),
        timeZone,
      } as Intl.ResolvedDateTimeFormatOptions;
    }
  );
}

afterEach(() => vi.restoreAllMocks());

describe("browserTimeZone", () => {
  it("returns the browser's IANA time zone", () => {
    stubBrowserTimeZone("Asia/Shanghai");
    expect(browserTimeZone()).toBe("Asia/Shanghai");
  });

  it("returns undefined when the browser reports no time zone", () => {
    stubBrowserTimeZone(undefined);
    expect(browserTimeZone()).toBeUndefined();
    stubBrowserTimeZone("");
    expect(browserTimeZone()).toBeUndefined();
  });

  it("returns undefined when Intl throws", () => {
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions"
    ).mockImplementation(() => {
      throw new Error("no Intl");
    });
    expect(browserTimeZone()).toBeUndefined();
  });
});

describe("timeZoneLabel", () => {
  it("names UTC for a cron stored without a time zone", () => {
    expect(timeZoneLabel(null)).toBe("UTC");
    expect(timeZoneLabel(undefined)).toBe("UTC");
    expect(timeZoneLabel("")).toBe("UTC");
  });

  it("shows the IANA name with spaces instead of underscores", () => {
    expect(timeZoneLabel("Europe/London")).toBe("Europe/London");
    expect(timeZoneLabel("America/New_York")).toBe("America/New York");
  });
});

describe("scheduleLabel", () => {
  it("appends the time zone to the schedule summary", () => {
    expect(scheduleLabel("0 9 * * *", "Asia/Shanghai")).toBe(
      "Every day at 09:00 · Asia/Shanghai"
    );
    expect(scheduleLabel("30 7 * * 1", null)).toBe("Every Mon at 07:30 · UTC");
  });

  it("keeps a custom cron expression as is", () => {
    expect(scheduleLabel("0 */2 * * *", "Europe/London")).toBe(
      "0 */2 * * * · Europe/London"
    );
  });
});
