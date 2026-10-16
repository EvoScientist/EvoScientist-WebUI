// Scheduled tasks run in the time zone their cron carries. A cron created
// without one is interpreted in UTC by the server, so labels must say which
// clock a schedule follows.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserTimeZone,
  cronLabel,
  cronToSpec,
  scheduleLabel,
  specToCron,
  timeZoneLabel,
} from "./cronUtils";

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

describe("cronToSpec", () => {
  it("reads the schedules the visual builder writes", () => {
    expect(cronToSpec("30 9 * * *")).toMatchObject({
      frequency: "daily",
      hour: 9,
      minute: 30,
    });
    expect(cronToSpec("09 07 * * *")).toMatchObject({
      frequency: "daily",
      hour: 7,
      minute: 9,
    });
    expect(cronToSpec("0 9 * * 1")).toMatchObject({
      frequency: "weekly",
      dayOfWeek: 1,
    });
    expect(cronToSpec("0 9 * * 0")).toMatchObject({
      frequency: "weekly",
      dayOfWeek: 0,
    });
    expect(cronToSpec("15 18 28 * *")).toMatchObject({
      frequency: "monthly",
      dayOfMonth: 28,
      hour: 18,
      minute: 15,
    });
  });

  // Most of these used to be read as a builder schedule from their first
  // number (or clamped into range), so saving the task unchanged rewrote it;
  // the rest pin the same rule.
  it.each([
    ["0 9 * * 1-5", "weekdays, once read as every Monday"],
    ["0 9 1,15 * *", "two days a month, once read as the 1st"],
    ["0 9,18 * * *", "twice a day, once read as 09:00"],
    ["0,30 9 * * *", "twice an hour"],
    ["0 9 31 * *", "the 31st, once clamped to the 28th"],
    ["0 9 * * 7", "Sunday as 7, once clamped to Saturday"],
    ["0 24 * * *", "an hour out of range"],
    ["60 9 * * *", "a minute out of range"],
    ["0 9.5 * * *", "a fractional hour"],
    ["0 9 * 1 *", "January only"],
    ["0 9 1 * 1", "both a day of the month and a weekday"],
    ["0 9 * * MON", "a weekday by name"],
    ["*/5 * * * *", "a step"],
    ["0 0-23/2 * * *", "a stepped range"],
  ])("keeps %s (%s) as a custom cron, verbatim", (cron) => {
    const spec = cronToSpec(cron);
    expect(spec.frequency).toBe("custom");
    expect(spec.custom).toBe(cron);
    expect(specToCron(spec)).toBe(cron);
    expect(cronLabel(cron)).toBe(cron);
  });

  it("lends the builder the fields a custom cron can show", () => {
    // A field that is not a plain number falls back to the default, not to
    // its first number: 2-5 gives Monday, 10,18 gives 09:00, 2,20 the 1st.
    expect(cronToSpec("30 14 * * 2-5")).toMatchObject({
      frequency: "custom",
      custom: "30 14 * * 2-5",
      hour: 14,
      minute: 30,
      dayOfWeek: 1,
    });
    expect(cronToSpec("15 18 20 1 *")).toMatchObject({
      frequency: "custom",
      hour: 18,
      minute: 15,
      dayOfMonth: 20,
    });
    expect(cronToSpec("0 10,18 * * 5")).toMatchObject({
      frequency: "custom",
      hour: 9,
      minute: 0,
      dayOfWeek: 5,
    });
    expect(cronToSpec("0 8 2,20 * *")).toMatchObject({
      frequency: "custom",
      hour: 8,
      minute: 0,
      dayOfMonth: 1,
    });
  });

  it("keeps an expression without five fields as a custom cron", () => {
    expect(cronToSpec("@daily")).toMatchObject({
      frequency: "custom",
      custom: "@daily",
    });
  });
});
